import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import mongoose from "mongoose";

// --- CONFIG & DISK SETUP ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOADS_DIR = path.join(process.cwd(), "uploads");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// --- MONGODB CONNECTION ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27001/service_call";
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// --- MODELS ---
const UserSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  mobileNumber: String,
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true }
});
const User = mongoose.model("User", UserSchema);

const ServiceSchema = new mongoose.Schema({
  state: String,
  town: String,
  category: String,
  providerName: String,
  description: String,
  contactNumber: String,
  operatingHours: String,
  photoUrls: [String],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});
const Service = mongoose.model("Service", ServiceSchema);

const RatingSchema = new mongoose.Schema({
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rating: Number,
  createdAt: { type: Date, default: Date.now }
});
RatingSchema.index({ serviceId: 1, userId: 1 }, { unique: true });
const Rating = mongoose.model("Rating", RatingSchema);

const PasswordResetSchema = new mongoose.Schema({
  email: String,
  code: String,
  expiresAt: Date
});
const PasswordReset = mongoose.model("PasswordReset", PasswordResetSchema);

// --- HELPERS ---
const saveBase64Image = (base64Str: string): string => {
  if (!base64Str.startsWith('data:image')) return base64Str;
  const matches = base64Str.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) return base64Str;
  const extension = matches[1].split('/')[1];
  const fileName = `${Math.random().toString(36).substring(2, 15)}.${extension}`;
  const filePath = path.join(UPLOADS_DIR, fileName);
  fs.writeFileSync(filePath, Buffer.from(matches[2], 'base64'));
  return `/uploads/${fileName}`;
};

// --- SERVER LOGIC ---
async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json({ limit: '10mb' }));
  app.use("/uploads", express.static(UPLOADS_DIR));

  // Auth Routes
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const user = new User(req.body);
      await user.save();
      res.json({ id: user._id, email: user.email, firstName: user.firstName });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email, password });
    if (user) {
      res.json({ id: user._id, email: user.email, firstName: user.firstName });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  // Services Routes
  app.get("/api/services", async (req, res) => {
    const { state, town, category, search, createdBy } = req.query;
    let filter: any = {};
    if (state) filter.state = state;
    if (town) filter.town = town;
    if (category) filter.category = category;
    if (createdBy) filter.createdBy = createdBy;
    if (search) {
      filter.$or = [
        { providerName: new RegExp(search as string, 'i') },
        { description: new RegExp(search as string, 'i') }
      ];
    }

    const services = await Service.find(filter).populate('createdBy', 'firstName lastName').sort({ createdAt: -1 });
    
    // Manual aggregation for ratings (simplified for this example)
    const formatted = await Promise.all(services.map(async (s: any) => {
      const ratings = await Rating.find({ serviceId: s._id });
      const avg = ratings.length ? ratings.reduce((a, b) => a + b.rating, 0) / ratings.length : 0;
      return { 
        ...s.toObject(), 
        id: s._id, 
        avgRating: avg, 
        ratingCount: ratings.length,
        creatorName: s.createdBy ? `${s.createdBy.firstName} ${s.createdBy.lastName}` : "Unknown"
      };
    }));

    res.json(formatted);
  });

  app.post("/api/services", async (req, res) => {
    try {
      const { photoUrls, ...data } = req.body;
      const processedUrls = (photoUrls || []).map((url: string) => saveBase64Image(url));
      const service = new Service({ ...data, photoUrls: processedUrls });
      await service.save();
      res.json(service);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/services/:id", async (req, res) => {
    const { userId } = req.query;
    const service = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ error: "Not found" });
    if (service.createdBy?.toString() !== userId) return res.status(403).json({ error: "Unauthorized" });
    
    await Service.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  });

  // Vite / Production Setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

startServer();
