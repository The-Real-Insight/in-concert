require('dotenv').config();

process.env.MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017?serverSelectionTimeoutMS=5000';
process.env.MONGO_DB = process.env.MONGO_DB ?? 'BPM';
