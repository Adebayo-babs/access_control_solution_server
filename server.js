// server.js
const express = require('express');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// MongoDB connection
let db;
// const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';

const MONGODB_URI = "mongodb+srv://Adebayo_server:Welldone123@access-control-db.rabjklj.mongodb.net/?appName=access-control-db"

const DB_NAME = 'access_control';

MongoClient.connect(MONGODB_URI)
  .then(client => {
    console.log('Connected to MongoDB');
    db = client.db(DB_NAME);
    
    // Create indexes
    db.collection('profiles').createIndex({ lagId: 1 }, { unique: true });
    db.collection('profiles').createIndex({ timestamp: -1 });
    db.collection('profiles').createIndex({ updatedAt: -1 });
  })
  .catch(err => console.error('MongoDB connection error:', err));

// Helper function to convert binary data
const convertBinaryData = (data) => {
  if (data && data.type === 'Buffer') {
    return Buffer.from(data.data);
  }
  if (typeof data === 'string') {
    return Buffer.from(data, 'base64');
  }
  return data;
};

// Face template comparison
const calculateTemplateSimilarity = (template1, template2) => {
  if (!template1 || !template2) {
    console.log('One or both templates are null');
    return 0;
  }
  
  const buf1 = Buffer.isBuffer(template1) ? template1 : Buffer.from(template1);
  const buf2 = Buffer.isBuffer(template2) ? template2 : Buffer.from(template2);
  
  if (buf1.length !== buf2.length) {
    console.log(`Template length mismatch: ${buf1.length} vs ${buf2.length}`);
    return 0;
  }

  let matchingBytes = 0;
  const totalBytes = buf1.length;

  // Compare bytes directly
  for (let i = 0; i < totalBytes; i++) {
    if (buf1[i] === buf2[i]) {
      matchingBytes++;
    }
  }

  // Calculate similarity percentage
  const similarity = (matchingBytes / totalBytes) * 100;
  return similarity;
};

// More accurate duplicate detection
const checkFaceDuplicate = async (faceTemplate) => {
  try {
    const allProfiles = await db.collection('profiles').find({}).toArray();
    const newTemplate = convertBinaryData(faceTemplate);

    console.log(`Checking face template against ${allProfiles.length} profiles`);
    console.log(`New template size: ${newTemplate.length} bytes`);

    let highestSimilarity = 0;
    let mostSimilarProfile = null;

    for (const profile of allProfiles) {
      const existingTemplate = profile.faceTemplate;
      
      // Calculate similarity
      const similarity = calculateTemplateSimilarity(newTemplate, existingTemplate);
      
      console.log(`Comparing with ${profile.name}: ${similarity.toFixed(2)}% similar`);

      if (similarity > highestSimilarity) {
        highestSimilarity = similarity;
        mostSimilarProfile = profile;
      }
    }

    const DUPLICATE_THRESHOLD = 80;

    console.log(`Highest similarity: ${highestSimilarity.toFixed(2)}%`);
    console.log(`Threshold: ${DUPLICATE_THRESHOLD}%`);

    if (highestSimilarity >= DUPLICATE_THRESHOLD) {
      console.log(`DUPLICATE DETECTED: ${mostSimilarProfile.name}`);
      return {
        isDuplicate: true,
        profile: mostSimilarProfile,
        similarity: highestSimilarity
      };
    }

    console.log('No duplicate found');
    return { 
      isDuplicate: false,
      highestSimilarity 
    };
  } catch (error) {
    console.error('Error checking face duplicate:', error);
    return { isDuplicate: false };
  }
};

// API Routes

// 1. Save/Create Profile with duplicate checks
app.post('/api/profiles', async (req, res) => {
  try {
    const { name, lagId, faceTemplate, faceImage, thumbnail } = req.body;

    console.log('\n NEW PROFILE REQUEST RECEIVED');
    console.log(`Name: ${name}`);
    console.log(`LAG ID: ${lagId}`);

    // Validate required fields
    if (!name || !lagId || !faceTemplate || !faceImage) {
      console.log('Missing required fields');
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }

    // Check for duplicate LAG ID
    const existingLagId = await db.collection('profiles').findOne({ lagId });
    if (existingLagId) {
      console.log(`Duplicate LAG ID found: ${existingLagId.name}`);
      return res.status(409).json({ 
        success: false, 
        error: `LAG ID '${lagId}' is already registered to ${existingLagId.name}`,
        duplicateType: 'LAG_ID'
      });
    }

    // Check for duplicate face template
    // console.log('Checking for duplicate face...');
    // const faceCheck = await checkFaceDuplicate(faceTemplate);
    // if (faceCheck.isDuplicate) {
    //   console.log(`Duplicate face found: ${faceCheck.profile.name} (${faceCheck.similarity.toFixed(2)}% similar)`);
    //   return res.status(409).json({ 
    //     success: false, 
    //     error: `This face is already registered as ${faceCheck.profile.name}`,
    //     duplicateType: 'FACE',
    //     similarity: faceCheck.similarity
    //   });
    // }

    console.log('No duplicates found. Saving profile...');

    // Convert base64 strings to binary
    const profile = {
      name,
      lagId,
      faceTemplate: convertBinaryData(faceTemplate),
      faceImage: convertBinaryData(faceImage),
      thumbnail: thumbnail ? convertBinaryData(thumbnail) : null,
      timestamp: Date.now(),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('profiles').insertOne(profile);

    console.log(`Profile saved successfully: ${result.insertedId}`);

    res.status(201).json({
      success: true,
      profileId: result.insertedId.toString(),
      message: 'Profile saved successfully'
    });

  } catch (error) {
    console.error('Error saving profile:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 2. Get All Profiles
app.get('/api/profiles', async (req, res) => {
  try {
    const { includeImages = 'false', includeThumbnails = 'true' } = req.query;

    const projection = {
      name: 1,
      lagId: 1,
      faceTemplate: 1,
      timestamp: 1,
      createdAt: 1,
      updatedAt: 1
    };

    // Optionally include images
    if (includeThumbnails === 'true') {
      projection.thumbnail = 1;
    }
    if (includeImages === 'true') {
      projection.faceImage = 1;
    }

    const profiles = await db.collection('profiles')
      .find({})
      .project(projection)
      .sort({ name: 1 })
      .toArray();

    const total = profiles.length;

    // Convert binary data to base64 for transmission
    const formattedProfiles = profiles.map(profile => ({
      id: profile._id.toString(),
      name: profile.name,
      lagId: profile.lagId,
      faceTemplate: profile.faceTemplate ? profile.faceTemplate.toString('base64') : null,
      faceImage: profile.faceImage ? profile.faceImage.toString('base64') : null,
      thumbnail: profile.thumbnail ? profile.thumbnail.toString('base64') : null,
      timestamp: profile.timestamp,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    }));

    res.json({
      success: true,
      profiles: formattedProfiles,
      total,
      serverTimestamp: Date.now()
    });

  } catch (error) {
    console.error('Error fetching profiles:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 3. Get profiles with pagination (for large datasets)
app.get('/api/profiles/paginated', async (req, res) => {
  try {
    const { page = 1, limit = 50, includeImages = 'false' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const projection = {
      name: 1,
      lagId: 1,
      faceTemplate: 1,
      thumbnail: 1,
      timestamp: 1
    };

    if (includeImages === 'true') {
      projection.faceImage = 1;
    }

    const profiles = await db.collection('profiles')
      .find({})
      .project(projection)
      .sort({ name: 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const total = await db.collection('profiles').countDocuments();

    const formattedProfiles = profiles.map(profile => ({
      id: profile._id.toString(),
      name: profile.name,
      lagId: profile.lagId,
      faceTemplate: profile.faceTemplate ? profile.faceTemplate.toString('base64') : null,
      faceImage: profile.faceImage ? profile.faceImage.toString('base64') : null,
      thumbnail: profile.thumbnail ? profile.thumbnail.toString('base64') : null,
      timestamp: profile.timestamp
    }));

    res.json({
      success: true,
      profiles: formattedProfiles,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      serverTimestamp: Date.now()
    });

  } catch (error) {
    console.error('Error fetching profiles:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 4. Get Profile by LAG ID
app.get('/api/profiles/lagid/:lagId', async (req, res) => {
  try {
    const { lagId } = req.params;

    const profile = await db.collection('profiles').findOne({ lagId });

    if (!profile) {
      return res.status(404).json({ 
        success: false, 
        error: 'Profile not found' 
      });
    }

    res.json({
      success: true,
      data: {
        id: profile._id.toString(),
        name: profile.name,
        lagId: profile.lagId,
        faceTemplate: profile.faceTemplate ? profile.faceTemplate.toString('base64') : null,
        faceImage: profile.faceImage ? profile.faceImage.toString('base64') : null,
        thumbnail: profile.thumbnail ? profile.thumbnail.toString('base64') : null,
        timestamp: profile.timestamp
      }
    });

  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 5. Get Profile by ID
app.get('/api/profiles/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const profile = await db.collection('profiles').findOne({ 
      _id: new ObjectId(id) 
    });

    if (!profile) {
      return res.status(404).json({ 
        success: false, 
        error: 'Profile not found' 
      });
    }

    res.json({
      success: true,
      data: {
        id: profile._id.toString(),
        name: profile.name,
        lagId: profile.lagId,
        faceTemplate: profile.faceTemplate ? profile.faceTemplate.toString('base64') : null,
        faceImage: profile.faceImage ? profile.faceImage.toString('base64') : null,
        thumbnail: profile.thumbnail ? profile.thumbnail.toString('base64') : null,
        timestamp: profile.timestamp
      }
    });

  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 6. Delete Profile
app.delete('/api/profiles/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.collection('profiles').deleteOne({ 
      _id: new ObjectId(id) 
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Profile not found' 
      });
    }

    res.json({
      success: true,
      message: 'Profile deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting profile:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 7. Delete Profile by LAG ID
app.delete('/api/profiles/lagid/:lagId', async (req, res) => {
  try {
    const { lagId } = req.params;

    const result = await db.collection('profiles').deleteOne({ lagId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Profile not found' 
      });
    }

    res.json({
      success: true,
      message: 'Profile deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting profile:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 8. Get profiles count
app.get('/api/profiles/stats/count', async (req, res) => {
  try {
    const count = await db.collection('profiles').countDocuments();
    res.json({
      success: true,
      data: count
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// NEW: Clear all profiles (for testing)
app.delete('/api/profiles/admin/clear-all', async (req, res) => {
  try {
    const result = await db.collection('profiles').deleteMany({});
    console.log(`Cleared ${result.deletedCount} profiles from database`);
    
    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} profiles`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error clearing profiles:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 9. Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'ok',
    timestamp: Date.now()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access at: http://localhost:${PORT}`);
});

module.exports = app;