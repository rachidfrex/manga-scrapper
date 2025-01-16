const puppeteer = require('puppeteer');
const Manga = require('./models/Manga');
const Chapter = require('./models/Chapter');

// Utility functions
async function retry(fn, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function searchManga(searchTerm) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        await page.goto(`https://like-manga.net/?s=${encodeURIComponent(searchTerm)}&post_type=wp-manga`, {
            waitUntil: 'networkidle0'
        });

        const searchResults = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.c-tabs-item__content')).map(item => ({
                title: item.querySelector('.post-title h3 a')?.innerText || '',
                url: item.querySelector('.post-title h3 a')?.href || '',
                poster: item.querySelector('.tab-thumb img')?.src || '',
                state: item.querySelector('.mg_status .summary-content')?.innerText || '',
                genres: Array.from(item.querySelectorAll('.mg_genres .summary-content a')).map(a => a.innerText),
                latestChapter: item.querySelector('.meta-item.latest-chap .chapter')?.innerText || '',
                rating: item.querySelector('.score.font-meta')?.innerText || ''
            })).filter(result => result.title);
        });

        return searchResults;
    } finally {
        if (browser) await browser.close();
    }
}

async function scrapeMangaAndChapters(mangaName, progressCallback) {
    let browser;
    try {
        progressCallback?.({
            status: 'started',
            message: 'جاري بدء العملية...',
            progress: 0
        });

        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions'
            ]
        });

        // Setup main page
        const mainPage = await browser.newPage();
        await mainPage.setDefaultNavigationTimeout(60000);
        await mainPage.setRequestInterception(true);
        mainPage.on('request', request => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Error handling
        mainPage.on('console', msg => console.log('Browser console:', msg.text()));
        mainPage.on('error', err => console.error('Page error:', err));

        // Navigate to manga page
        const formattedName = mangaName.toLowerCase().replace(/\s+/g, '-');
        const baseUrl = `https://like-manga.net/manga/${formattedName}`;
        console.log('Accessing URL:', baseUrl);

        const response = await mainPage.goto(baseUrl, { waitUntil: 'networkidle0' });
        if (response.status() === 404) {
            throw new Error('manga_not_found');
        }

        // Wait for content
        await mainPage.waitForSelector('.post-title h1, .error-404', { timeout: 10000 });

        // Check for 404
        const notFound = await mainPage.$('.error-404');
        if (notFound) {
            throw new Error('manga_not_found');
        }

        // Get manga info
        const mangaData = await mainPage.evaluate(() => {
            const title = document.querySelector('.post-title h1')?.innerText;
            if (!title) throw new Error('Could not find manga title');

            return {
                title,
                poster: document.querySelector('.summary_image a img')?.src || '',
                state: Array.from(document.querySelectorAll('.post-content_item'))
                    .find(item => item.querySelector('.summary-heading h5')?.innerText.includes('الحالة'))
                    ?.querySelector('.summary-content')?.innerText || 'Ongoing',
                genres: Array.from(document.querySelectorAll('.genres-content a'))
                    .map(genre => genre.innerText),
                description: document.querySelector('.summary__content')?.innerText || '',
                chapters: Array.from(document.querySelectorAll('.wp-manga-chapter a'))
                    .map(a => ({
                        number: parseInt(a.innerText.match(/\d+/)?.[0] || '0'),
                        url: a.href
                    }))
                    .filter(chapter => chapter.number > 0)
                    .reverse()
            };
        });

        // Check if manga already exists with better error handling
        const existingManga = await Manga.findOne({ 
            $or: [
                { title: mangaData.title },
                { slug: mangaData.title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-') }
            ]
        });

        if (existingManga) {
            progressCallback?.({
                status: 'error',
                message: 'هذه المانجا موجودة بالفعل',
                progress: 0
            });
            // Return search results instead
            const searchResults = await searchManga(mangaName);
            throw { 
                message: 'manga_exists',
                existingManga,
                searchResults
            };
        }

        // Save manga with retry logic
        let manga;
        try {
            manga = new Manga({
                title: mangaData.title,
                poster: mangaData.poster,
                state: mangaData.state,
                genres: mangaData.genres,
                description: mangaData.description,
                chapters: []
            });
            await manga.save();
        } catch (saveError) {
            if (saveError.code === 11000) { // Duplicate key error
                // Add a random suffix to make the slug unique
                manga = new Manga({
                    title: mangaData.title,
                    poster: mangaData.poster,
                    state: mangaData.state,
                    genres: mangaData.genres,
                    description: mangaData.description,
                    chapters: [],
                    slug: `${mangaData.title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')}-${Date.now()}`
                });
                await manga.save();
            } else {
                throw saveError;
            }
        }

        // Process chapters
        const BATCH_SIZE = 3;
        const chapters = mangaData.chapters;
        const totalChapters = chapters.length;
        let completedChapters = 0;

        for (let i = 0; i < chapters.length; i += BATCH_SIZE) {
            const batch = chapters.slice(i, Math.min(i + BATCH_SIZE, chapters.length));
            
            const promises = batch.map(async (chapter) => {
                try {
                    const chapterPage = await browser.newPage();
                    await chapterPage.setRequestInterception(true);
                    chapterPage.on('request', request => {
                        if (!['document', 'script'].includes(request.resourceType())) {
                            request.abort();
                        } else {
                            request.continue();
                        }
                    });

                    const progress = Math.round((completedChapters / totalChapters) * 80) + 10;
                    progressCallback?.({
                        status: 'chapter_progress',
                        message: `جاري تحميل الفصل ${chapter.number}`,
                        progress,
                        currentChapter: completedChapters + 1,
                        totalChapters
                    });

                    await chapterPage.goto(chapter.url, { waitUntil: 'networkidle0' });
                    const chapterPages = await chapterPage.evaluate(() => {
                        return Array.from(document.querySelectorAll('.wp-manga-chapter-img'))
                            .map((img, index) => ({
                                pageNumber: index + 1,
                                imageUrl: img.src
                            }))
                            .filter(page => page.imageUrl?.startsWith('http'));
                    });

                    if (chapterPages.length > 0) {
                        const newChapter = new Chapter({
                            mangaId: manga._id,
                            chapterNumber: chapter.number,
                            title: `Chapter ${chapter.number}`,
                            pages: chapterPages
                        });
                        await newChapter.save();
                        manga.chapters.push(newChapter._id);
                        completedChapters++;
                    }

                    await chapterPage.close();
                } catch (error) {
                    console.error(`Error scraping chapter ${chapter.number}:`, error.message);
                }
            });

            await Promise.all(promises);
            await manga.save();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        progressCallback?.({
            status: 'completed',
            message: 'تم الانتهاء بنجاح',
            progress: 100
        });

        return manga;

    } catch (error) {
        if (error.message === 'manga_exists') {
            throw error; // Rethrow with search results
        }
        console.error('Scraping error:', error);
        throw error;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = {
    scrapeMangaAndChapters,
    searchManga
};

