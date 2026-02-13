// auth.js - Authentication routes and middleware
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

// Secret key for JWT - In production, use environment variable
const JWT_SECRET = process.env.JWT_SECRET || 'mySuperSecretKeyThatIsVeryLong12345';

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Access denied. No token provided.' 
    });
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (error) {
    res.status(403).json({ 
      success: false, 
      error: 'Invalid or expired token.' 
    });
  }
};

// Setup authentication routes
const setupAuthRoutes = (app, db) => {
  
  // Register new admin (keep this for initial setup, but can be disabled in production)
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { username, email, password } = req.body;

      // Validation
      if (!username || !email || !password) {
        return res.status(400).json({ 
          success: false, 
          error: 'All fields are required' 
        });
      }

      if (password.length < 6) {
        return res.status(400).json({ 
          success: false, 
          error: 'Password must be at least 6 characters' 
        });
      }

      // Check if admin already exists
      const existingAdmin = await db.collection('admins').findOne({ 
        $or: [{ email }, { username }] 
      });

      if (existingAdmin) {
        return res.status(409).json({ 
          success: false, 
          error: 'Username or email already exists' 
        });
      }

      // Hash password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      // Create admin
      const admin = {
        username,
        email,
        password: hashedPassword,
        createdAt: new Date(),
        lastLogin: null
      };

      const result = await db.collection('admins').insertOne(admin);

      // Create JWT token
      const token = jwt.sign(
        { 
          id: result.insertedId.toString(), 
          username,
          email 
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.status(201).json({
        success: true,
        message: 'Admin registered successfully',
        token,
        admin: {
          id: result.insertedId.toString(),
          username,
          email
        }
      });

    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Server error during registration' 
      });
    }
  });

  // Create new user (authenticated admins only)
  app.post('/api/auth/create-user', authenticateToken, async (req, res) => {
    try {
      const { username, email, password } = req.body;

      // Validation
      if (!username || !email || !password) {
        return res.status(400).json({ 
          success: false, 
          error: 'All fields are required' 
        });
      }

      if (password.length < 6) {
        return res.status(400).json({ 
          success: false, 
          error: 'Password must be at least 6 characters' 
        });
      }

      // Check if user already exists
      const existingUser = await db.collection('admins').findOne({ 
        $or: [{ email }, { username }] 
      });

      if (existingUser) {
        return res.status(409).json({ 
          success: false, 
          error: 'Username or email already exists' 
        });
      }

      // Hash password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      // Create user
      const user = {
        username,
        email,
        password: hashedPassword,
        createdBy: req.user.id,
        createdAt: new Date(),
        lastLogin: null
      };

      const result = await db.collection('admins').insertOne(user);

      console.log(`New user created by ${req.user.username}: ${username}`);

      res.status(201).json({
        success: true,
        message: 'User created successfully',
        user: {
          id: result.insertedId.toString(),
          username,
          email
        }
      });

    } catch (error) {
      console.error('Create user error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Server error during user creation' 
      });
    }
  });

  // Login
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      // Validation
      if (!username || !password) {
        return res.status(400).json({ 
          success: false, 
          error: 'Username and password are required' 
        });
      }

      // Find admin by username or email
      const admin = await db.collection('admins').findOne({ 
        $or: [{ username }, { email: username }] 
      });

      if (!admin) {
        return res.status(401).json({ 
          success: false, 
          error: 'Invalid credentials' 
        });
      }

      // Verify password
      const validPassword = await bcrypt.compare(password, admin.password);
      if (!validPassword) {
        return res.status(401).json({ 
          success: false, 
          error: 'Invalid credentials' 
        });
      }

      // Update last login
      await db.collection('admins').updateOne(
        { _id: admin._id },
        { $set: { lastLogin: new Date() } }
      );

      // Create JWT token
      const token = jwt.sign(
        { 
          id: admin._id.toString(), 
          username: admin.username,
          email: admin.email 
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({
        success: true,
        message: 'Login successful',
        token,
        admin: {
          id: admin._id.toString(),
          username: admin.username,
          email: admin.email
        }
      });

    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Server error during login' 
      });
    }
  });

  // Verify token (check if user is authenticated)
  app.get('/api/auth/verify', authenticateToken, async (req, res) => {
    try {
      const admin = await db.collection('admins').findOne({ 
        _id: new ObjectId(req.user.id) 
      });

      if (!admin) {
        return res.status(404).json({ 
          success: false, 
          error: 'Admin not found' 
        });
      }

      res.json({
        success: true,
        admin: {
          id: admin._id.toString(),
          username: admin.username,
          email: admin.email
        }
      });
    } catch (error) {
      console.error('Verification error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Server error during verification' 
      });
    }
  });

  // Logout (client-side handles token removal, but we can add server-side logging)
  app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
      // Optional: Add logout logging or token blacklisting here
      res.json({
        success: true,
        message: 'Logout successful'
      });
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Server error during logout' 
      });
    }
  });
};

module.exports = { setupAuthRoutes, authenticateToken };