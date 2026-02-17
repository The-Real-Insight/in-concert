require('dotenv').config();

let mongoUrl =
  process.env.MONGO_URL ?? 'mongodb://localhost:27017/tri-bpmn-engine-test?serverSelectionTimeoutMS=5000';

// If no database in path (e.g. mongodb.net/ or mongodb.net/?...), use Test to avoid case conflict
if (!mongoUrl.match(/\/[^/?#]+(\?|$)/)) {
  mongoUrl = mongoUrl.includes('?') ? mongoUrl.replace(/\/\?/, '/Test?') : mongoUrl.replace(/\/?$/, '/Test');
}

process.env.MONGO_URL = mongoUrl;
