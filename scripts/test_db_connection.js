import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';

const {
  MONGO_URI,
  DB_USER,
  DB_PASS,
  DB_CLUSTER,
  DB_NAME,
} = process.env;

let mongoConnectUri = MONGO_URI || null;
if (!mongoConnectUri && DB_USER && DB_PASS && DB_CLUSTER && DB_NAME) {
  const encPass = encodeURIComponent(DB_PASS);
  mongoConnectUri = `mongodb+srv://${DB_USER}:${encPass}@${DB_CLUSTER}/${DB_NAME}?retryWrites=true&w=majority`;
}

if (!mongoConnectUri) {
  console.error('No MongoDB URI available in environment.');
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(mongoConnectUri, { dbName: DB_NAME || 'booking_bot', useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');

    const testBooking = new Booking({ phone: 'TEST_' + Date.now(), step: 'test', meta: { test: true } });
    const saved = await testBooking.save();
    console.log('Saved booking id:', saved._id.toString());

    const found = await Booking.findById(saved._id).lean();
    console.log('Found booking document:', found);

    // Clean up
    await Booking.deleteOne({ _id: saved._id });
    console.log('Deleted test booking');

    await mongoose.disconnect();
    console.log('Disconnected');
    process.exit(0);
  } catch (err) {
    console.error('Error during DB test:', err);
    process.exit(2);
  }
})();
