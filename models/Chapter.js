const mongoose = require('mongoose');
const schema = mongoose.Schema;

const chapterSchema = new schema({
    mangaId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Manga',
        required: true
    },
    chapterNumber: {
        type: Number,
        required: true
    },
    title: String,
    pages: [{
        pageNumber: Number,
        imageUrl: String
    }],
    creationDate: {
        type: Date,
        default: Date.now
    }
});

const Chapter = mongoose.model('Chapter', chapterSchema);
module.exports = Chapter;