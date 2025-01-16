const express = require('express');
const mongoose = require('mongoose');
const Manga = require('./models/Manga');
const Chapter = require('./models/Chapter');
const { scrapeMangaAndChapters, searchManga, checkMangaUpdates, checkMangaUrl } = require('./puppeteer');
const app = express();
app.use(express.static('public'));

app.use(express.json());
mongoose.connect("mongodb+srv://rachid7518:qg5Y3eDQJG2hbHF@cluster0.ikmiq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0")
.then(  () => {
    console.log('Connected to the database');
}
).catch( (err) => {
    console.log(err);
}
)

// Maintain active connections
const clients = new Map();
app.get('/', (req, res) => {
    res.redirect('/mangas');
}
);


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

// get a manga by id and chapters
app.get('/manga/:slug', async (req, res) => {
    try {
        const manga = await Manga.findBySlug(req.params.slug).populate({
            path: 'chapters',
            options: { sort: { 'chapterNumber': -1 } }
        });
        
        if(!manga){
            return res.status(404).send('No manga found');
        }
        res.render('chapters.ejs', { manga });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});

// get chapter pages
app.get('/manga/:slug/chapter/:chapterId', async (req, res) => {
    try {
        const manga = await Manga.findBySlug(req.params.slug);
        const chapter = await Chapter.findById(req.params.chapterId);
        
        if (!manga || !chapter) {
            return res.status(404).send('Not found');
        }

        // Get previous and next chapters
        const chapters = await Chapter.find({ mangaId: manga._id })
            .sort({ chapterNumber: 1 });
        
        const currentIndex = chapters.findIndex(c => c._id.toString() === chapter._id.toString());
        const prevChapter = currentIndex > 0 ? chapters[currentIndex - 1] : null;
        const nextChapter = currentIndex < chapters.length - 1 ? chapters[currentIndex + 1] : null;

        res.render('page.ejs', { 
            manga, 
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
            if (scrapeError.message === 'manga_exists') {
                return res.status(409).json({
                    success: false,
                    message: 'هذه المانجا موجودة بالفعل',
                    existingManga: scrapeError.existingManga,
                    searchResults: scrapeError.searchResults
                });
            }
            if (scrapeError.message === 'manga_not_found') {
                const searchResults = await searchManga(mangaName);
                return res.status(404).json({ 
                    success: false, 
                    message: 'لم يتم العثور على المانجا المطلوبة',
                    searchResults
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

// Add diagnostic endpoint
app.get('/check-manga/:name', async (req, res) => {
    try {
        const result = await checkMangaUrl(req.params.name);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(3000, '192.168.1.34', () => {
    console.log('Server is running http://192.168.1.34:3000');
});