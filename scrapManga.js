
const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const Manga = require('./models/Manga');
const Chapter = require('./models/Chapter');
const readline = require('readline');


function askForMangaName() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question('Enter manga name: ', (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function scrapeMangaAndChapters(mangaName) {
    if (!mangaName) {
        console.log('Skipping manga scraping...');
        return null;
    }

    // Launch browser with performance optimizations
    const browser = await puppeteer.launch({
        
        headless: "false",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-extensions'
        ]
    });

    try {
        // Create page with optimized settings
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            // Block unnecessary resources
            const resourceType = request.resourceType();
            if (['stylesheet', 'font', 'image'].includes(resourceType)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        const formattedName = mangaName.toLowerCase().replace(/\s+/g, '-');
        const baseUrl = `https://like-manga.net/manga/${formattedName}`;
        
        // Scrape manga info with optimized wait
        await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        const mangaData = await page.evaluate(() => {
            const title = document.querySelector('.post-title h1')?.innerText || '';
            const state = Array.from(document.querySelectorAll('.post-content_item'))
                .find(item => item.querySelector('.summary-heading h5')?.innerText.includes('الحالة'))
                ?.querySelector('.summary-content')?.innerText || '';
            const poster = document.querySelector('.summary_image a img')?.src || '';
            const genres = Array.from(document.querySelectorAll('.genres-content a'))
                .map(genre => genre.innerText);
            const description = Array.from(document.querySelectorAll('.summary__content p'))
                .map(p => p.innerText).join('\n');

            const chapters = Array.from(document.querySelectorAll('.wp-manga-chapter a'))
                .map(a => ({
                    number: parseInt(a.innerText.trim()),
                    url: a.href
                }))
                .filter(chapter => !isNaN(chapter.number))
                .reverse();

            return { title, poster, state, genres, description, chapters };
        });

        // Save manga
        const manga = new Manga({
            title: mangaData.title,
            poster: mangaData.poster,
            state: mangaData.state,
            genres: mangaData.genres,
            description: mangaData.description,
            chapters: []
        });
        await manga.save();
        console.log('Manga saved:', manga.title);

        // Process chapters in parallel batches
        const BATCH_SIZE = 5;
        const chapters = mangaData.chapters;
        
        for (let i = 0; i < chapters.length; i += BATCH_SIZE) {
            const batch = chapters.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (chapter) => {
                const chapterPage = await browser.newPage();
                await chapterPage.setRequestInterception(true);
                chapterPage.on('request', (request) => {
                    const resourceType = request.resourceType();
                    if (!['document', 'xhr', 'fetch', 'script'].includes(resourceType)) {
                        request.abort();
                    } else {
                        request.continue();
                    }
                });

                try {
                    await chapterPage.goto(chapter.url, { 
                        waitUntil: 'networkidle0',
                        timeout: 30000 
                    });

                    const chapterPages = await chapterPage.evaluate(() => {
                        return Array.from(document.querySelectorAll('.wp-manga-chapter-img'))
                            .map((img, index) => ({
                                pageNumber: index + 1,
                                imageUrl: img.src
                            }));
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
                        console.log(`Chapter ${chapter.number} saved with ${chapterPages.length} pages`);
                    }
                } catch (error) {
                    console.error(`Error scraping chapter ${chapter.number}:`, error);
                } finally {
                    await chapterPage.close();
                }
            });

            // Wait for batch to complete
            await Promise.all(promises);
            // Save manga after each batch
            await manga.save();
            console.log(`Completed batch of ${batch.length} chapters`);
        }

        console.log('All chapters saved successfully');
        return manga;

    } catch (error) {
        console.error('Error:', error);
        return null;
    } finally {
        await browser.close();
    }
}

// Main execution
(async () => {
    try {
        await mongoose.connect("mongodb+srv://rachid7518:qg5Y3eDQJG2hbHF@cluster0.ikmiq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0");
        console.log('Connected to database');

        const mangaName = process.argv[2] || await askForMangaName();
        const result = await scrapeMangaAndChapters(mangaName);
        
        if (result) {
            console.log('Successfully scraped manga and all chapters');
        }

    } catch (error) {
        console.error('Main error:', error);
    } finally {
        await mongoose.connection.close();
    }
})();

