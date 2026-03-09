import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const db = new Database("service_call.db");

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// Helper to save base64 to file
const saveBase64Image = (base64Str: string): string => {
  if (!base64Str.startsWith('data:image')) return base64Str; // Already a URL or not an image

  const matches = base64Str.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) return base64Str;

  const extension = matches[1].split('/')[1];
  const fileName = `${Math.random().toString(36).substring(2, 15)}.${extension}`;
  const filePath = path.join(UPLOADS_DIR, fileName);
  const buffer = Buffer.from(matches[2], 'base64');
  
  fs.writeFileSync(filePath, buffer);
  return `/uploads/${fileName}`;
};

// Helper to delete images
const deleteImages = (photoUrlsJson: string) => {
  try {
    const urls = JSON.parse(photoUrlsJson) as string[];
    urls.forEach(url => {
      if (url.startsWith('/uploads/')) {
        const fileName = url.replace('/uploads/', '');
        const filePath = path.join(UPLOADS_DIR, fileName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    });
  } catch (e) {
    console.error("Error deleting images:", e);
  }
};

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    firstName TEXT,
    lastName TEXT,
    mobileNumber TEXT,
    email TEXT UNIQUE,
    password TEXT
  );

  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    state TEXT,
    town TEXT,
    category TEXT,
    providerName TEXT,
    description TEXT,
    contactNumber TEXT,
    operatingHours TEXT,
    photoUrl TEXT,
    createdBy TEXT,
    createdAt INTEGER,
    FOREIGN KEY(createdBy) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    email TEXT PRIMARY KEY,
    code TEXT,
    expiresAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY,
    serviceId TEXT,
    userId TEXT,
    rating INTEGER,
    createdAt INTEGER,
    UNIQUE(serviceId, userId),
    FOREIGN KEY(serviceId) REFERENCES services(id),
    FOREIGN KEY(userId) REFERENCES users(id)
  );
`);

// Migration: Rename district to town if it exists
try {
  const tableInfo = db.prepare("PRAGMA table_info(services)").all() as any[];
  const hasDistrict = tableInfo.some(col => col.name === 'district');
  const hasTown = tableInfo.some(col => col.name === 'town');
  
  if (hasDistrict && !hasTown) {
    db.exec("ALTER TABLE services RENAME COLUMN district TO town");
    console.log("Migrated 'district' column to 'town'");
  }

  const hasDescription = tableInfo.some(col => col.name === 'description');
  if (!hasDescription) {
    db.exec("ALTER TABLE services ADD COLUMN description TEXT");
    console.log("Added 'description' column to 'services' table");
  }
} catch (err) {
  console.error("Migration error:", err);
}

async function startServer() {
  const app = express();
  const PORT = 3005;

  app.use(express.json({ limit: '10mb' }));
  app.use("/uploads", express.static(UPLOADS_DIR));

  // API Routes
  app.post("/api/auth/signup", (req, res) => {
    const { firstName, lastName, mobileNumber, email, password } = req.body;
    const id = Math.random().toString(36).substring(2, 15);
    try {
      db.prepare("INSERT INTO users (id, firstName, lastName, mobileNumber, email, password) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, firstName, lastName, mobileNumber, email, password);
      res.json({ id, firstName, lastName, email, mobileNumber });
    } catch (err: any) {
      console.error("Signup error:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body;
    try {
      const user = db.prepare("SELECT * FROM users WHERE email = ? AND password = ?").get(email, password) as any;
      if (user) {
        res.json({ id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, mobileNumber: user.mobileNumber });
      } else {
        res.status(401).json({ error: "Invalid credentials" });
      }
    } catch (err: any) {
      console.error("Login error:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/forgot-password", (req, res) => {
    const { email } = req.body;
    try {
      const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
      if (!user) {
        return res.status(404).json({ error: "User with this email not found" });
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

      db.prepare("INSERT OR REPLACE INTO password_resets (email, code, expiresAt) VALUES (?, ?, ?)")
        .run(email, code, expiresAt);

      // In a real app, you'd send an actual email here.
      // For this demo, we'll log it to console and return it in the response for testing convenience.
      console.log(`[MOCK EMAIL] To: ${email}, Code: ${code}`);
      
      res.json({ message: "Reset code sent to your email", debugCode: code });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/verify-reset-code", (req, res) => {
    const { email, code } = req.body;
    try {
      const reset = db.prepare("SELECT * FROM password_resets WHERE email = ? AND code = ?").get(email, code) as any;
      if (reset && reset.expiresAt > Date.now()) {
        res.json({ success: true });
      } else {
        res.status(400).json({ error: "Invalid or expired code" });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/reset-password", (req, res) => {
    const { email, code, newPassword } = req.body;
    try {
      const reset = db.prepare("SELECT * FROM password_resets WHERE email = ? AND code = ?").get(email, code) as any;
      if (reset && reset.expiresAt > Date.now()) {
        db.prepare("UPDATE users SET password = ? WHERE email = ?").run(newPassword, email);
        db.prepare("DELETE FROM password_resets WHERE email = ?").run(email);
        res.json({ success: true });
      } else {
        res.status(400).json({ error: "Invalid or expired code" });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/services", (req, res) => {
    const { state, town, category, search, createdBy, currentUserId } = req.query;
    let query = `
      SELECT s.*, u.firstName || ' ' || u.lastName as creatorName,
             (SELECT AVG(rating) FROM ratings WHERE serviceId = s.id) as avgRating,
             (SELECT COUNT(*) FROM ratings WHERE serviceId = s.id) as ratingCount
    `;

    if (currentUserId) {
      query += `, (SELECT rating FROM ratings WHERE serviceId = s.id AND userId = ?) as userRating `;
    }

    query += `
      FROM services s 
      JOIN users u ON s.createdBy = u.id 
      WHERE 1=1
    `;
    const params: any[] = [];
    if (currentUserId) params.push(currentUserId);

    if (state) {
      query += " AND s.state = ?";
      params.push(state);
    }
    if (town) {
      query += " AND s.town = ?";
      params.push(town);
    }
    if (category) {
      query += " AND s.category = ?";
      params.push(category);
    }
    if (createdBy) {
      query += " AND s.createdBy = ?";
      params.push(createdBy);
    }
    if (search) {
      query += " AND (s.providerName LIKE ? OR s.category LIKE ? OR s.description LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += " ORDER BY s.createdAt DESC";
    const services = db.prepare(query).all(...params) as any[];
    const formattedServices = services.map(s => ({
      ...s,
      photoUrls: s.photoUrl ? JSON.parse(s.photoUrl) : [],
      avgRating: s.avgRating || 0,
      ratingCount: s.ratingCount || 0
    }));
    res.json(formattedServices);
  });

  app.put("/api/services/:id", (req, res) => {
    const { id } = req.params;
    const { state, town, category, providerName, description, contactNumber, operatingHours, photoUrls, createdBy } = req.body;
    
    try {
      // Verify user exists
      const userExists = db.prepare("SELECT id FROM users WHERE id = ?").get(createdBy);
      if (!userExists) {
        return res.status(401).json({ error: "Your session has expired. Please logout and login again." });
      }

      // Check ownership
      const service = db.prepare("SELECT * FROM services WHERE id = ?").get(id) as any;
      if (!service) return res.status(404).json({ error: "Service not found" });
      if (service.createdBy !== createdBy) return res.status(403).json({ error: "Unauthorized" });

      // Process photos: save new ones, keep old ones
      const processedUrls = (photoUrls || []).map((url: string) => saveBase64Image(url));
      const photoUrlJson = JSON.stringify(processedUrls);

      // Delete old photos that are no longer in the list
      const oldUrls = JSON.parse(service.photoUrl || "[]") as string[];
      oldUrls.forEach(oldUrl => {
        if (oldUrl.startsWith('/uploads/') && !processedUrls.includes(oldUrl)) {
          const fileName = oldUrl.replace('/uploads/', '');
          const filePath = path.join(UPLOADS_DIR, fileName);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      });

      db.prepare("UPDATE services SET state = ?, town = ?, category = ?, providerName = ?, description = ?, contactNumber = ?, operatingHours = ?, photoUrl = ? WHERE id = ?")
        .run(state, town, category, providerName, description, contactNumber, operatingHours, photoUrlJson, id);
      
      res.json({ id, state, town, category, providerName, description, contactNumber, operatingHours, photoUrls: processedUrls, createdBy });
    } catch (err: any) {
      console.error("Update service error:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/services", (req, res) => {
    const { state, town, category, providerName, description, contactNumber, operatingHours, photoUrls, createdBy } = req.body;
    console.log("POST /api/services - createdBy:", createdBy);
    
    const id = Math.random().toString(36).substring(2, 15);
    const createdAt = Date.now();
    
    try {
      // Verify user exists to avoid foreign key failure
      const user = db.prepare("SELECT id FROM users WHERE id = ?").get(createdBy);
      if (!user) {
        console.error("Service creation failed: User does not exist", createdBy);
        return res.status(401).json({ error: "Your session has expired or user not found. Please logout and login again." });
      }

      // Process photos
      const processedUrls = (photoUrls || []).map((url: string) => saveBase64Image(url));
      const photoUrlJson = JSON.stringify(processedUrls);

      const stmt = db.prepare("INSERT INTO services (id, state, town, category, providerName, description, contactNumber, operatingHours, photoUrl, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      stmt.run(id, state, town, category, providerName, description, contactNumber, operatingHours, photoUrlJson, createdBy, createdAt);
      res.json({ id, state, town, category, providerName, description, contactNumber, operatingHours, photoUrls: processedUrls, createdBy, createdAt });
    } catch (err: any) {
      console.error("Create service error:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/services/:id", (req, res) => {
    const { id } = req.params;
    const { userId } = req.query;

    try {
      const service = db.prepare("SELECT * FROM services WHERE id = ?").get(id) as any;
      if (!service) return res.status(404).json({ error: "Service not found" });
      if (service.createdBy !== userId) return res.status(403).json({ error: "Unauthorized" });

      // Delete images from disk
      deleteImages(service.photoUrl);

      // Delete from DB
      db.prepare("DELETE FROM services WHERE id = ?").run(id);
      res.json({ success: true });
    } catch (err: any) {
      console.error("Delete service error:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/categories/top", (req, res) => {
    const top = db.prepare("SELECT category, COUNT(*) as count FROM services GROUP BY category ORDER BY count DESC LIMIT 6").all() as any[];
    
    const topWithThumbnails = top.map(cat => {
      const services = db.prepare("SELECT photoUrl FROM services WHERE category = ? AND photoUrl IS NOT NULL LIMIT 4").all(cat.category) as any[];
      const thumbnails: string[] = [];
      services.forEach(s => {
        const urls = JSON.parse(s.photoUrl || "[]");
        if (urls.length > 0) thumbnails.push(urls[0]);
      });
      return { ...cat, thumbnails };
    });
    
    res.json(topWithThumbnails);
  });

  app.post("/api/services/:id/rate", (req, res) => {
    const { id } = req.params;
    const { userId, rating } = req.body;
    
    if (!userId || !rating) return res.status(400).json({ error: "Missing userId or rating" });
    
    try {
      const ratingId = Math.random().toString(36).substring(2, 15);
      db.prepare("INSERT OR REPLACE INTO ratings (id, serviceId, userId, rating, createdAt) VALUES (?, ?, ?, ?, ?)")
        .run(ratingId, id, userId, rating, Date.now());
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
