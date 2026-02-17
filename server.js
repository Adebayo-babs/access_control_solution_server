// server.js
const express = require('express');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const { setupAuthRoutes, authenticateToken } = require('./auth');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files (HTML, CSS, JS)
app.use(express.static(__dirname));

// Serve login page as default route
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/login.html');
});

// MongoDB connection
let db;
let sseClients = [];
const MONGODB_URI = "mongodb+srv://Adebayo_server:Welldone123@access-control-db.rabjklj.mongodb.net/?appName=access-control-db"
const DB_NAME = 'access_control';

MongoClient.connect(MONGODB_URI)
  .then(client => {
    console.log('Connected to MongoDB Atlas');
    db = client.db(DB_NAME);
    
    // Create indexes
    db.collection('profiles').createIndex({ lagId: 1 }, { unique: true });
    db.collection('profiles').createIndex({ timestamp: -1 });
    db.collection('profiles').createIndex({ updatedAt: -1 });
    db.collection('access_logs').createIndex({ timestamp: -1 });
    db.collection('access_logs').createIndex({ lagId: 1 });
    db.collection('access_logs').createIndex({ date: -1 });
    db.collection('attendance').createIndex({ lagId: 1, date: -1 });
    db.collection('attendance').createIndex({ date: -1 });
    db.collection('admins').createIndex({ username: 1 }, { unique: true });
    db.collection('admins').createIndex({ email: 1 }, { unique: true });
    
    // Setup authentication routes
    setupAuthRoutes(app, db);
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

// Save/Create Profile with duplicate checks
app.post('/api/profiles', async (req, res) => {
  try {
    const { name, lagId, faceTemplate, faceImage, thumbnail } = req.body;

    console.log('\n=== NEW PROFILE REQUEST RECEIVED ===');
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

// Server Sent Events for real-time updates
app.get('/api/attendance/stream', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send initial message to establish connection
  res.write(`data: {"type": "connection-established"}\n\n`);

  // Keep the connection alive with periodic pings every 30 seconds
  const pingInterval = setInterval(() => {
    res.write(`data: {"type": "heartbeat"}\n\n`);
  }, 30000);

  // Add client to list
  sseClients.push(res);

  // Remove client on close
  req.on('close', () => {
    clearInterval(pingInterval);
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Healper function to send SSE updates
const broadcastAttendanceUpdate = (update) => {
  const message = `data: ${JSON.stringify({ type: 'attendance-update', update })}\n\n`;
  sseClients.forEach(client => client.write(message));
}

// Get All Profiles
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

    // Include images
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

// Get profiles with pagination (for large datasets)
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

// Get Profile by LAG ID
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

// Get Profile by ID
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

// Delete Profile
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

// Delete Profile by LAG ID
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

// Get profiles count
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

// Clear all profiles (for testing)
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

// ACCESS LOGS AND ATTENDANCE ROUTES
// Log Access Attempt
app.post('/api/access/logs', async (req, res) => {
  try {
    const { 
      lagId, 
      name, 
      accessGranted,  
      deviceId, 
      accessType = 'CARD',
     } = req.body;

    const accessLog = {
      lagId: lagId || 'UNKNOWN',
      name: name || 'Unknown',
      accessGranted,
      accessType,
      deviceId: deviceId || 'UNKNOWN',
      timestamp: Date.now(),
      date: new Date().toISOString().split('T')[0],
      time: new Date().toTimeString().split(' ')[0],
      createdAt: new Date()
    };

    const result = await db.collection('access_logs').insertOne(accessLog);

    console.log(`Access logged: ${name} - ${accessGranted ? 'GRANTED' : 'DENIED'}`);

    res.status(201).json({
      success: true,
      logId: result.insertedId.toString(),
      message: 'Access logged successfully'
    });
  } catch (error) {
    console.error('Error logging access:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});


// Access Logs with filters
app.get('/api/access/logs', async (req, res) => {
  try {
    const { lagId, accessGranted, startDate, endDate, limit = 100, page = 1 } = req.query;

    const query = {};

    if (lagId) query.lagId = lagId;
    if (accessGranted !== undefined) query.accessGranted = accessGranted === 'true';

    if (startDate || endDate) {
      query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const logs = await db.collection('access_logs')
    .find(query)
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .toArray();

    const total = await db.collection('access_logs').countDocuments(query);

    const formattedLogs = logs.map(log => ({
      id: log._id.toString(),
      lagId: log.lagId, 
      name: log.name,
      accessGranted: log.accessGranted,
      accessType: log.accessType,
      deviceId: log.deviceId,
      timestamp: log.timestamp,
      date: log.date,
      time: log.time
    }));

    res.json({
      success: true,
      logs: formattedLogs,
      total: total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),      
    });

  } catch (error) {
    console.error('Error fetching access logs:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    }); 
  }
});

// Access Statistics
app.get('/api/access/stats', async (req, res) => {
  try {

    const {startDate, endDate} = req.query;
    const query = {};
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }

    const totalAttempts = await db.collection('access_logs').countDocuments(query);
    const grantedAccess = await db.collection('access_logs').countDocuments({
       ...query, 
       accessGranted: true 
      });
    const deniedAccess = await db.collection('access_logs').countDocuments({ 
      ...query, 
      accessGranted: false 
    }); 

    // Get top denied access users
    const deniedUsers = await db.collection('access_logs').aggregate([
      { $match: { ...query, accessGranted: false } },
      { $group: { 
        _id: '$lagId', 
        name: { $first: '$name' },
        count: { $sum: 1 } 
      }},
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray();

    res.json({
      success: true,
      data: {
        totalAttempts,
        grantedAccess,
        deniedAccess,
        successRate: totalAttempts > 0 ? ((grantedAccess / totalAttempts) * 100).toFixed(2) : 0,
        topDeniedUsers: deniedUsers.map(u => ({
          lagId: u._id,
          name: u.name,
          deniedCount: u.count
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching access stats:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});


// Attendance tracking

// Clock in/out
app.post('/api/attendance/clock', async (req, res) => {
  try {
    const { lagId, name, action } = req.body;  // action: 'IN' | 'OUT'
    if (!lagId || !action) {
      return res.status(400).json({ 
        success: false, 
        error: 'lagId and action are required' 
      });
    }

    const today = new Date().toISOString().split('T')[0];
    const currentTime = Date.now();
    const currentTimeFormatted = new Date().toTimeString().split(' ')[0];

    // Find today's attendance record
    let attendance = await db.collection('attendance').findOne({ 
      lagId, 
      date: today 
    });

    if (action === 'IN') {
      // Check if there is an active session (Clocked in but not out)
      if (attendance?.sessions) {
        const activeSession = attendance.sessions.find(s => s.clockIn && !s.clockOut);
        if (activeSession) {
          return res.status(400).json({
            success: false,
            error: 'Already clocked in'
          });
        }
      }

      // Create new session
      const newSession = {
        clockIn: currentTime,
        clockInTime: currentTimeFormatted,
        clockOut: null,
        clockOutTime: null,
        duration: null
      };

      if (!attendance) {
        // Create new attendance record with sessions array
        attendance = {
          lagId,
          name,
          date: today,
          sessions: [newSession],
          totalDuration: 0,
          totalDurationFormatted: '0h 0m',
          status: 'ACTIVE',
          createdAt: new Date(),
          updatedAt: new Date()
        };
        await db.collection('attendance').insertOne(attendance);
      } else {
        // Add new session to existing record
        await db.collection('attendance').updateOne(
          { lagId, date: today },
          { 
            $push: { sessions: newSession },
            $set: { 
              status: 'ACTIVE',
              updatedAt: new Date()
          }
        }
        );
      }
      console.log(`Clocked IN: ${name} (${lagId}) at ${currentTimeFormatted}`);

    } else if (action === 'OUT') {
      if (!attendance || !attendance.sessions || attendance.sessions.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Please clock in first'
        });
      }

      // Find the active session (clocked in but not out )
      const activeSessionIndex = attendance.sessions.findIndex(s => s.clockIn && !s.clockOut);

      if (activeSessionIndex === -1) {
        return res.status(400).json({
          success: false,
          error: 'Already clocked out'
        });
      }

      // Calculate duration for this session
      const activeSession = attendance.sessions[activeSessionIndex];
      const sessionDuration = currentTime - activeSession.clockIn;
      const hours = Math.floor(sessionDuration / (1000 * 60 * 60));
      const minutes = Math.floor((sessionDuration % (1000 * 60 * 60)) / (1000 * 60));

      // Update the active session
      attendance.sessions[activeSessionIndex].clockOut = currentTime;
      attendance.sessions[activeSessionIndex].clockOutTime = currentTimeFormatted;
      attendance.sessions[activeSessionIndex].duration = sessionDuration;
      attendance.sessions[activeSessionIndex].durationFormatted = `${hours}h ${minutes}m`;

      // Calculate total duration for the day
      const totalDuration = attendance.sessions.reduce((sum, session) => {
        return sum + (session.duration || 0);
      }, 0);
      const totalHours = Math.floor(totalDuration / (1000 * 60 * 60));
      const totalMinutes = Math.floor((totalDuration % (1000 * 60 * 60)) / (1000 * 60));

      // Check if all sessions are completed
      const hasActiveSessions = attendance.sessions.some(s => s.clockIn && !s.clockOut);
      const newStatus = hasActiveSessions ? 'ACTIVE' : 'COMPLETED';

    
      await db.collection('attendance').updateOne(
        { lagId, date: today },
        { 
          $set: {
            sessions: attendance.sessions,
            totalDuration: totalDuration,
            totalDurationFormatted: `${totalHours}h ${totalMinutes}m`,
            status: newStatus,
            updatedAt: new Date()
          } 
        }
      );

      console.log(`Clocked OUT: ${name} (${lagId}) at ${currentTimeFormatted} (Session: ${hours}h ${minutes}m), Total: ${totalHours}h ${totalMinutes}m`);
    }

    // Fetch updated record
    const updatedAttendance = await db.collection('attendance').findOne({ lagId, date: today });


    broadcastAttendanceUpdate();
    res.json({
      success: true,
      message: `Clocked ${action.toLowerCase()} successfully`,
      attendance: updatedAttendance
    })

    } catch (error) {
    console.error('Error clocking attendance:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get Attendance Records
app.get('/api/attendance', async (req, res) => {
  try {
    const { lagId, startDate, endDate, status, limit = 100, page = 1 } = req.query;

    const query = {};
    
    if (lagId) query.lagId = lagId;
    if (status) query.status = status;
    
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const records = await db.collection('attendance')
      .find(query)
      .sort({ date: -1})
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const total = await db.collection('attendance').countDocuments(query);

    const formattedRecords = records.map(record => ({
      id: record._id.toString(),
      lagId: record.lagId,
      name: record.name,
      date: record.date,
      sessions: record.sessions || [],
      totalDuration: record.totalDuration || 0,
      totalDurationFormatted: record.totalDurationFormatted || '0h 0m',
      status: record.status,
      // Backward compatibility - use first session if exists
      clockIn: record.sessions?.[0]?.clockIn || null,
      clockInTime: record.sessions?.[0]?.clockInTime || null,
      clockOut: record.sessions?.[record.sessions.length -1]?.clockOut || null,
      clockOutTime: record.sessions?.[record.sessions.length -1]?.clockOutTime || null
    }));

    res.json({
      success: true,
      records: formattedRecords,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });

  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get Today's Attendance
app.get('/api/attendance/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const records = await db.collection('attendance')
      .find({ date: today })
      .sort({ updatedAt: -1 })
      .toArray();

    const activeNow = records.filter(r => r.status === 'ACTIVE').length;
    const completed = records.filter(r => r.status === 'COMPLETED').length;

    res.json({
      success: true,
      data: {
        date: today,
        totalPresent: records.length,
        activeNow,
        completed,
        records: records.map(record => ({
          id: record._id.toString(),
          lagId: record.lagId,
          name: record.name,
          sessions: record.sessions || [],
          totalDurationFormatted: record.totalDurationFormatted || '0h 0m',
          status: record.status,
          lastAction: record.sessions?.length > 0 
            ? (record.sessions[record.sessions.length -1].clockOut 
              ? `Clocked OUT at ${record.sessions[record.sessions.length -1].clockOutTime}` 
              : `Clocked IN at ${record.sessions[record.sessions.length -1].clockInTime}`) 
            : 'No activity'
        }))
      }
    });

  } catch (error) { 
    console.error('Error fetching today\'s attendance:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get Attendance Report
app.get('/api/attendance/report', async (req, res) => {
  try {
    const { lagId, month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({ 
        success: false, 
        error: 'Month and year are required' 
      });
    }

    // Calculate date range for the month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    const query = {
      date: { $gte: startDate, $lte: endDate }
    };

    if (lagId) {
      query.lagId = lagId;
    }

    const records = await db.collection('attendance')
      .find(query)
      .sort({ date: 1 })
      .toArray();

    // Calculate statistics
    const totalDays = records.length;
    const completedDays = records.filter(r => r.status === 'COMPLETED').length;
    const totalDuration = records.reduce((sum, r) => sum + (r.duration || 0), 0);
    const avgDuration = totalDays > 0 ? totalDuration / totalDays : 0;
    
    const hours = Math.floor(avgDuration / (1000 * 60 * 60));
    const minutes = Math.floor((avgDuration % (1000 * 60 * 60)) / (1000 * 60));

    const totalHours = Math.floor(totalDuration / (1000 * 60 * 60));
    const totalMinutes = Math.floor((totalDuration % (1000 * 60 * 60)) / (1000 * 60));

    res.json({
      success: true,
      report: {
        period: `${year}-${String(month).padStart(2, '0')}`,
        lagId: lagId || 'ALL',
        totalDays,
        completedDays,
        incompleteDays: totalDays - completedDays,
        totalDurationFormatted: `${totalHours}h ${totalMinutes}m`,
        avgDurationFormatted: `${hours}h ${minutes}m`,
        records: records.map(record => ({
          date: record.date,
          sessions: record.sessions || [],
          totalDurationFormatted: record.totalDurationFormatted || '0h 0m',
          status: record.status,
          sessionsCount: record.sessions?.length || 0
        }))
      }
    });

  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check
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