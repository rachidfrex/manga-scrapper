const express = require('express');
const mongoose = require('mongoose');
const Article = require("./models/Article");
const methodOverride = require('method-override');
const app = express();
app.use(express.json());
app.use(express.static('public'));
mongoose.connect("mongodb+srv://rachid7518:qg5Y3eDQJG2hbHF@cluster0.ikmiq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0")
.then(  () => {
    console.log('Connected to the database');
}
).catch( (err) => {
    console.log(err);
}
)


app.get('/', async(req ,res)=>{
    
    const blogs = await Article.find();
    res.render('index.ejs', {
        blogs: blogs,
        


        });
})

app.get("/findSummation/:number1/:number2", (req, res) => {
    const num1 = parseInt(req.params.number1, 10);
    const num2 = Number(req.params.number2)
    const total = num1 +num2;
    res.send( `the sume of ${num1} and ${num2} is ${total}` )
})

app.get("/testbody", (req, res) => {
    
    const firstName = req.body.name;
    const lastName = req.body.lastname;
    const age = req.body.age;


   
    res.send(`Hello ${firstName} ${lastName}, you are ${age} years old`);
})





// article routes 
app.use(express.urlencoded({extended: true}));

const validation = (req, res, next) => {
    const title = req.body.title;
    const body = req.body.body;
    if(!title || !body){
        
        return res.redirect('/articles');
      

    }else{
  
        return next();
    }
        
   
    
}

app.post('/articles',  validation ,async (req, res)=>{
   try{
 
    const  newArticle = new Article();
    newArticle.title = req.body.title;
    newArticle.body = req.body.body;
    await newArticle.save()
    const articles = await Article.find();
    res.render('Articles', {
    articles: articles,
    message: 'Article created successfully',
    status: "success"}
    );
    console.log(articles);
    // res.status(201).json({
    //     articles: articles,
    //     message: 'Article created successfully',
    //     status: "success"
    // });
   }catch(err){
       console.log(err);
       res.redirect('/articles');
   }


})

app.get('/articles', async (req, res) => {
    const articles = await Article.find();
    res.render('articles.ejs', { articles: articles });
});

app.use(methodOverride('_method'));

app.delete('/articles/:id', async(req, res)=>{
    try{

        const id = req.params.id;
        await Article.findByIdAndDelete(id);
        res.redirect('/articles');
    }catch(err){
        console.log(err);
        res.redirect('/articles');
    }
 
    

})
// edit article
app.get('/articles/:id/edit',async(req, res)=>{
    const id = req.params.id;
    const article = await Article.findById(id);
    res.render('edit.ejs', {article: article});
}
)
app.put('/articles/:id', validation, async(req, res)=>{
    try{
    const id = req.parmes.id;
    const article = await Article.findById(id);
    const title = req.body.title;
    const body = req.body.body;
    article.title = title;
    article.body = body;
    await article.save();
    }catch(err){
        console.log(err);
        res.redirect('/articles');
       
    }
})



app.listen(3000, ()=>{
    console.log('Server is running on port 3000');
});
