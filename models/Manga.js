const mongoose = require('mongoose');
const schema = mongoose.Schema;

// Improved slug generation function
async function generateUniqueSlug(title, doc) {
    let slug = title
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/--+/g, '-')
        .trim();

    const similar = await mongoose.model('Manga').findOne({ slug: new RegExp(`^${slug}(?:-\\d+)?$`) })
        .sort({ slug: -1 });

    if (similar && similar._id.toString() !== doc._id?.toString()) {
        const match = similar.slug.match(new RegExp(`^${slug}(?:-?(\\d+))?$`));
        const num = match && match[1] ? parseInt(match[1]) + 1 : 1;
        slug = `${slug}-${num}`;
    }

    return slug;
}

const mangaSchema = new schema({
    title: String,
    poster: String,
    state: String,
    genres: [String],
    description: String,
    chapters: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Chapter'
    }],
    creationDate: {
        type: Date,
        default: Date.now
    },
    slug: {
        type: String,
        unique: true
    }
});

// Updated pre-save middleware
mangaSchema.pre('save', async function(next) {
    if (!this.slug && this.title) {
        this.slug = await generateUniqueSlug(this.title, this);
    }
    next();
});

// Add static method to find by slug
mangaSchema.statics.findBySlug = function(slug) {
    return this.findOne({ slug: slug });
};

const Manga = mongoose.model('Manga', mangaSchema);
module.exports = Manga;