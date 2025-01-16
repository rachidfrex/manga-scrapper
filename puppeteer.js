const puppeteer = require('puppeteer');
const Manga = require('./models/Manga');
const Chapter = require('./models/Chapter');

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
                '--disable-extensions',
                '--window-size=1920,1080',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        // Setup main page with increased timeouts
        const mainPage = await browser.newPage();
        await mainPage.setDefaultNavigationTimeout(120000); // 2 minutes
        await mainPage.setViewport({ width: 1920, height: 1080 });
        
        // More reliable request interception
        await mainPage.setRequestInterception(true);
        mainPage.on('request', request => {
            if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Better error handling
        mainPage.on('console', msg => console.log('Browser console:', msg.text()));
        mainPage.on('error', err => console.error('Page error:', err));
        mainPage.on('pageerror', err => console.error('Page error:', err));

        // Navigate to manga page
        const formattedName = mangaName.toLowerCase().replace(/\s+/g, '-');
        const baseUrl = `https://like-manga.net/manga/${formattedName}`;
        console.log('Accessing URL:', baseUrl);

        try {
            const response = await mainPage.goto(baseUrl, { 
                waitUntil: ['networkidle0', 'domcontentloaded'],
                timeout: 60000 // 1 minute
            });

            // Check current URL after navigation
            const currentUrl = mainPage.url();
            if (currentUrl === 'https://like-manga.net/' || currentUrl === 'https://like-manga.net') {
                console.log('Redirected to homepage - manga not found');
                // Search for similar manga immediately
                const searchResults = await searchManga(mangaName);
                throw {
                    message: 'manga_not_found',
                    searchResults: searchResults
                };
            }

            // Wait for content with retries
            let contentLoaded = false;
            let retries = 3;
            while (!contentLoaded && retries > 0) {
                try {
                    await mainPage.waitForSelector('.post-title h1, .error-404', {
                        timeout: 30000,
                        visible: true
                    });
                    contentLoaded = true;
                } catch (error) {
                    retries--;
                    if (retries === 0) {
                        // Check if page loaded but selector not found
                        const content = await mainPage.content();
                        if (content.includes('error-404') || content.includes('Page not found')) {
                            const similarResults = await findSimilarManga(mangaName);
                            throw {
                                message: 'manga_not_found',
                                searchResults: similarResults
                            };
                        }
                        throw new Error('page_load_timeout');
                    }
                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
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

        } catch (navigationError) {
            if (navigationError.message.includes('net::ERR_')) {
                throw {
                    message: 'network_error',
                    details: 'فشل الاتصال بالموقع. يرجى التحقق من اتصالك بالإنترنت'
                };
            }
            if (navigationError.message === 'page_load_timeout') {
                throw {
                    message: 'timeout_error',
                    details: 'استغرقت العملية وقتاً طويلاً. يرجى المحاولة مرة أخرى'
                };
            }
            throw navigationError;
        }

    } catch (error) {
        if (['manga_exists', 'manga_not_found', 'network_error', 'timeout_error'].includes(error.message)) {
            throw error;
        }
        console.error('Scraping error:', error);
        throw {
            message: 'scraping_error',
            details: 'حدث خطأ أثناء محاولة جلب المانجا. يرجى المحاولة مرة أخرى'
        };
    } finally {
        if (browser) await browser.close();
    }
}

async function checkMangaUpdates(mangaSlug) {
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

        const formattedName = mangaSlug.replace(/-\d+$/, ''); // Remove any timestamp suffix
        const url = `https://like-manga.net/manga/${formattedName}`;
        
        await page.goto(url, { waitUntil: 'networkidle0' });

        const newChapters = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.wp-manga-chapter a'))
                .map(a => ({
                    number: parseInt(a.innerText.match(/\d+/)?.[0] || '0'),
                    url: a.href
                }))
                .filter(chapter => chapter.number > 0)
                .reverse();
        });

        const manga = await Manga.findOne({ slug: mangaSlug }).populate('chapters');
        const existingChapterNumbers = manga.chapters.map(ch => ch.chapterNumber);
        const newChaptersList = newChapters.filter(ch => !existingChapterNumbers.includes(ch.number));

        if (newChaptersList.length > 0) {
            for (const chapter of newChaptersList) {
                const chapterPage = await browser.newPage();
                await chapterPage.setRequestInterception(true);
                chapterPage.on('request', request => {
                    if (!['document', 'script'].includes(request.resourceType())) {
                        request.abort();
                    } else {
                        request.continue();
                    }
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
                }

                await chapterPage.close();
            }

            await manga.save();
            return { updatesFound: true, newChaptersCount: newChaptersList.length };
        }

        return { updatesFound: false, newChaptersCount: 0 };

    } finally {
        if (browser) await browser.close();
    }
}

async function findSimilarManga(searchTerm) {
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

        // Search using partial match
        await page.goto(`https://like-manga.net/?s=${encodeURIComponent(searchTerm)}&post_type=wp-manga`, {
            waitUntil: 'networkidle0'
        });

        const searchResults = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.c-tabs-item__content'))
                .map(item => ({
                    title: item.querySelector('.post-title h3 a')?.innerText || '',
                    url: item.querySelector('.post-title h3 a')?.href || '',
                    poster: item.querySelector('.tab-thumb img')?.src || '',
                    state: item.querySelector('.mg_status .summary-content')?.innerText || '',
                    genres: Array.from(item.querySelectorAll('.mg_genres .summary-content a')).map(a => a.innerText),
                    latestChapter: item.querySelector('.meta-item.latest-chap .chapter')?.innerText || '',
                    rating: item.querySelector('.score.font-meta')?.innerText || ''
                }))
                .filter(result => result.title);
        });

        // Calculate similarity scores
        const results = searchResults.map(manga => ({
            ...manga,
            similarity: calculateSimilarity(searchTerm.toLowerCase(), manga.title.toLowerCase())
        }));

        // Sort by similarity score
        return results.sort((a, b) => b.similarity - a.similarity);

    } finally {
        if (browser) await browser.close();
    }
}

// Add Levenshtein Distance calculation for similarity
function calculateSimilarity(s1, s2) {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    const longerLength = longer.length;
    if (longerLength === 0) return 1.0;

    const costs = new Array(shorter.length + 1);
    for (let i = 0; i <= shorter.length; i++) costs[i] = i;

    for (let i = 0; i < longer.length; i++) {
        let nw = i;
        costs[0] = i + 1;
        for (let j = 0; j < shorter.length; j++) {
            const cj = Math.min(
                costs[j] + 1,
                costs[j + 1] + 1,
                nw + (longer[i] !== shorter[j] ? 1 : 0)
            );
            nw = costs[j + 1];
            costs[j + 1] = cj;
        }
    }

    return (longerLength - costs[shorter.length]) / longerLength;
}

module.exports = {
    scrapeMangaAndChapters,
    searchManga,
    checkMangaUpdates,
    findSimilarManga
};

