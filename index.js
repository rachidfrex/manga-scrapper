const express = require('express');
require('dotenv').config();
const mongoose = require('mongoose');
const Manga = require('./models/Manga');
const Chapter = require('./models/Chapter');
const { scrapeMangaAndChapters, searchManga, checkMangaUpdates, findSimilarManga } = require('./puppeteer');
const app = express();
app.use(express.static('public'));

app.use(express.json());
// mongoose.connect("mongodb+srv://rachid7518:qg5Y3eDQJG2hbHF@cluster0.ikmiq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0")
// .then(  () => {
//     console.log('Connected to the database');
// }
// ).catch( (err) => {
//     console.log(err);
// }
// )
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => {
    console.log('Connected to the database');
  })
  .catch((err) => {
    console.log('MongoDB connection error:', err);
  });

// Maintain active connections
const clients = new Map();
app.get('/', (req, res) => {
    res.redirect('/mangas');
}
);

// Add these constants at the top
const CHAPTERS_PER_PAGE = 50;
const CACHE_DURATION = 3600000; // 1 hour in milliseconds
const chaptersCache = new Map();

// Add to your Express routes
app.post('/manga/:slug/check-updates', async (req, res) => {
    try {
        const { slug } = req.params;
        const result = await checkMangaUpdates(slug);
        res.json(result);
    } catch (error) {
        console.error('Update check error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'فشل في التحقق من التحديثات',
            error: error.message 
        });
    }
});


// Update the mangas route to handle success message
app.get('/mangas', async (req, res) => {
    try {
        const mangas = await Manga.find();
        if(!mangas){
            return res.status(404).send('No mangas found');
        }
        
        res.render('mangas.ejs', {
            mangas: mangas,
            message: req.query.deleted ? 'تم حذف المانجا بنجاح' : null
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});

// Update the manga route to include pagination
app.get('/manga/:slug', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const cacheKey = `${req.params.slug}_${page}`;

        // Check cache first
        if (chaptersCache.has(cacheKey)) {
            const cached = chaptersCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_DURATION) {
                return res.render('chapters.ejs', cached.data);
            }
        }

        const manga = await Manga.findBySlug(req.params.slug);
        if (!manga) {
            const similarResults = await findSimilarManga(req.params.slug.replace(/-/g, ' '));
            return res.render('notFound.ejs', { 
                searchTerm: req.params.slug.replace(/-/g, ' '),
                similarResults: similarResults.slice(0, 5)
            });
        }

        // Get total chapters count
        const totalChapters = await Chapter.countDocuments({ mangaId: manga._id });
        const totalPages = Math.ceil(totalChapters / CHAPTERS_PER_PAGE);

        // Get paginated chapters
        const chapters = await Chapter.find({ mangaId: manga._id })
            .sort({ chapterNumber: -1 })
            .skip((page - 1) * CHAPTERS_PER_PAGE)
            .limit(CHAPTERS_PER_PAGE)
            .select('chapterNumber title creationDate _id');

        const data = { 
            manga: { ...manga.toObject(), chapters },
            currentPage: page,
            totalPages,
            totalChapters
        };

        // Cache the result
        chaptersCache.set(cacheKey, {
            data,
            timestamp: Date.now()
        });

        res.render('chapters.ejs', data);
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});

// Update API endpoint for lazy loading chapters
app.get('/api/manga/:slug/chapters', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const manga = await Manga.findBySlug(req.params.slug);
        
        if (!manga) {
            return res.status(404).json({ message: 'Manga not found' });
        }

        // Get total count for pagination
        const totalChapters = await Chapter.countDocuments({ mangaId: manga._id });
        const totalPages = Math.ceil(totalChapters / CHAPTERS_PER_PAGE);

        const chapters = await Chapter.find({ mangaId: manga._id })
            .sort({ chapterNumber: -1 })
            .skip((page - 1) * CHAPTERS_PER_PAGE)
            .limit(CHAPTERS_PER_PAGE)
            .select('chapterNumber title creationDate _id');

        res.json({ 
            chapters,
            currentPage: page,
            totalPages,
            hasMore: page < totalPages
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

// get chapter pages
app.get('/manga/:slug/chapter/:chapterId', async (req, res) => {
    try {
        const manga = await Manga.findBySlug(req.params.slug).populate({
            path: 'chapters',
            options: { sort: { chapterNumber: -1 } }
        });
        const chapter = await Chapter.findById(req.params.chapterId);
        
        if (!manga || !chapter) {
            return res.status(404).send('Not found');
        }

        // Ensure chapters are properly loaded
        const chapters = await Chapter.find({ mangaId: manga._id })
            .sort({ chapterNumber: -1 });
        
        const currentIndex = chapters.findIndex(c => c._id.toString() === chapter._id.toString());
        const prevChapter = currentIndex < chapters.length - 1 ? chapters[currentIndex + 1] : null;
        const nextChapter = currentIndex > 0 ? chapters[currentIndex - 1] : null;

        res.render('page.ejs', { 
            manga: {
                ...manga.toObject(),
                chapters: chapters // Use the properly sorted chapters
            }, 
            chapter,
            prevChapter,
            nextChapter
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});

// Add manga form route
app.get('/add-manga', (req, res) => {
    res.render('addManga.ejs');
});

// Modify SSE endpoint
app.get('/scrape-progress/:mangaName', (req, res) => {
    const mangaName = req.params.mangaName;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Store the response object with the manga name as key
    clients.set(mangaName, res);

    req.on('close', () => {
        clients.delete(mangaName);
        res.end();
    });
});

// Add search endpoint
app.post('/search-manga', async (req, res) => {
    try {
        const { searchTerm } = req.body;
        if (!searchTerm) {
            return res.status(400).json({ message: 'Search term is required' });
        }

        const searchResults = await searchManga(searchTerm);
        res.json({
            success: true,
            results: searchResults
        });

    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'فشل في البحث'
        });
    }
});

// Update the add manga endpoint
app.post('/add-manga', async (req, res) => {
    const { mangaName } = req.body;
    
    if (!mangaName) {
        return res.status(400).json({ message: 'اسم المانجا مطلوب' });
    }

    const progressCallback = (data) => {
        const client = clients.get(mangaName);
        if (client) {
            client.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    try {
        try {
            const result = await scrapeMangaAndChapters(mangaName, progressCallback);
            return res.json({ 
                success: true, 
                message: 'تم إضافة المانجا بنجاح',
                manga: {
                    title: result.title,
                    slug: result.slug,
                    chaptersCount: result.chapters.length
                }
            });
        } catch (scrapeError) {
            if (scrapeError.message === 'manga_not_found') {
                // Return search results immediately
                return res.status(404).json({ 
                    success: false, 
                    message: 'لم يتم العثور على المانجا المطلوبة',
                    searchResults: scrapeError.searchResults || []
                });
            }
            if (scrapeError.message === 'timeout_error') {
                return res.status(504).json({
                    success: false,
                    message: scrapeError.details || 'استغرقت العملية وقتاً طويلاً'
                });
            }
            if (scrapeError.message === 'manga_exists') {
                return res.status(409).json({
                    success: false,
                    message: 'هذه المانجا موجودة بالفعل',
                    existingManga: scrapeError.existingManga,
                    searchResults: scrapeError.searchResults
                });
            }
            if (scrapeError.message === 'network_error') {
                return res.status(503).json({
                    success: false,
                    message: scrapeError.details || 'فشل الاتصال بالموقع'
                });
            }
            throw scrapeError;
        }
    } catch (error) {
        // Error handling with client notification
        const client = clients.get(mangaName);
        if (client) {
            client.write(`data: ${JSON.stringify({
                status: 'error',
                message: error.message,
                progress: 0
            })}\n\n`);
        }

        console.error('Error adding manga:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'فشل في إضافة المانجا'
        });
    } finally {
        const client = clients.get(mangaName);
        if (client) {
            client.end();
            clients.delete(mangaName);
        }
    }
});

// Add delete manga endpoint
app.delete('/manga/:slug', async (req, res) => {
    try {
        const manga = await Manga.findBySlug(req.params.slug);
        if (!manga) {
            return res.status(404).json({ message: 'المانجا غير موجودة' });
        }

        // Delete all chapters associated with the manga
        await Chapter.deleteMany({ mangaId: manga._id });
        
        // Delete the manga
        await Manga.findByIdAndDelete(manga._id);

        res.json({ 
            success: true, 
            message: 'تم حذف المانجا بنجاح' 
        });
    } catch (error) {
        console.error('Error deleting manga:', error);
        res.status(500).json({ 
            success: false, 
            message: 'فشل في حذف المانجا' 
        });
    }
});

// app.listen(3000, '192.168.1.34', () => {
//     console.log('Server is running http://192.168.1.34:3000');
// });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});