const express = require('express');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests' });
  }
});

const TRACKER_FILE = path.join(__dirname, 'downloadTracker.json');
const DEFAULT_FILES_DIR = path.join(__dirname, 'public', 'files');
const LOG_FILE = path.join(__dirname, 'server.log');

const ALLOWED_BASE_PATHS = [
  DEFAULT_FILES_DIR,
  // Add other allowed absolute paths here:
  // '/path/to/your/files',
  // 'C:\\path\\to\\windows\\files'
];

const initializeServer = async () => {
  try {
    if (!fs.existsSync(DEFAULT_FILES_DIR)) {
      fs.mkdirSync(DEFAULT_FILES_DIR, { recursive: true });
      log('Created default files directory');
    }

    if (!fs.existsSync(TRACKER_FILE)) {
      fs.writeFileSync(TRACKER_FILE, JSON.stringify({}));
      log('Created download tracker file');
    }

    const files = fs.readdirSync(DEFAULT_FILES_DIR);
    if (files.length === 0) {
      fs.writeFileSync(path.join(DEFAULT_FILES_DIR, 'example.txt'), 'This is a test file');
      log('Created example file for testing');
    }
  } catch (err) {
    log(`Server initialization failed: ${err.message}`, true);
    process.exit(1);
  }
};

app.use(express.json());
app.use(express.static('public'));

app.get('/api/files', apiLimiter, async (req, res) => {
  try {
    const tracker = await readTrackerFile();
    let allFiles = [];

    for (const basePath of ALLOWED_BASE_PATHS) {
      try {
        const files = fs.readdirSync(basePath);
        
        const fileDetails = files.map(file => {
          const filePath = path.join(basePath, file);
          const stats = fs.statSync(filePath);
          
          return {
            name: file,
            path: filePath, 
            size: stats.size,
            available: tracker[file] !== 'downloaded',
            lastModified: stats.mtime,
            type: getFileType(path.extname(file).substring(1)),
            downloadUrl: `/download/${encodeURIComponent(file)}?source=${encodeURIComponent(basePath)}`
          };
        });

        allFiles = [...allFiles, ...fileDetails];
      } catch (err) {
        log(`Error reading directory ${basePath}: ${err.message}`, true);
        continue;
      }
    }

    if (allFiles.length === 0) {
      log('No files found in any allowed directories', true);
    }

    res.json(allFiles);
  } catch (error) {
    log(`API error: ${error.message}`, true);
    res.status(500).json({ 
      error: 'Unable to read files',
      details: error.message,
      allowedPaths: ALLOWED_BASE_PATHS 
    });
  }
});

app.get('/download/:filename', apiLimiter, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const sourcePath = decodeURIComponent(req.query.source || '');

    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    let basePath;
    if (sourcePath && ALLOWED_BASE_PATHS.includes(sourcePath)) {
      basePath = sourcePath;
    } else {
      basePath = DEFAULT_FILES_DIR;
    }

    const filePath = path.join(basePath, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const isAllowed = ALLOWED_BASE_PATHS.some(allowedPath => {
      const relative = path.relative(allowedPath, filePath);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });

    if (!isAllowed) {
      return res.status(403).json({ error: 'Access to this file is forbidden' });
    }

    const tracker = await readTrackerFile();
    tracker[filename] = 'downloaded';
    await writeTrackerFile(tracker);

    res.download(filePath, filename, (err) => {
      if (err) {
        log(`Download error: ${err.message}`, true);
        tracker[filename] = 'available';
        writeTrackerFile(tracker).catch(e => log(`Tracker update error: ${e.message}`, true));
      } else {
        log(`File downloaded: ${filename} from ${basePath}`);
      }
    });

  } catch (error) {
    log(`Download error: ${error.message}`, true);
    res.status(500).json({ 
      error: 'Download failed',
      details: error.message
    });
  }
});

async function readTrackerFile() {
  try {
    const data = await fs.promises.readFile(TRACKER_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    log(`Tracker read error: ${error.message}`, true);
    return {};
  }
}

async function writeTrackerFile(data) {
  try {
    await fs.promises.writeFile(TRACKER_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    log(`Tracker write error: ${error.message}`, true);
    throw error;
  }
}

function getFileType(extension) {
  const typeMap = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'],
    document: ['pdf', 'doc', 'docx', 'txt', 'md'],
    code: ['js', 'html', 'css', 'py', 'json'],
    archive: ['zip', 'rar', '7z'],
    audio: ['mp3', 'wav'],
    video: ['mp4', 'mov']
  };

  extension = extension.toLowerCase();
  for (const [type, exts] of Object.entries(typeMap)) {
    if (exts.includes(extension)) return type;
  }
  return 'other';
}

function log(message, isError = false) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${isError ? 'ERROR: ' : ''}${message}\n`;
  
  console.log(logMessage.trim());
  fs.appendFile(LOG_FILE, logMessage, (err) => {
    if (err) console.error('Log write error:', err);
  });
}

app.use((err, req, res, next) => {
  log(`Unhandled error: ${err.stack}`, true);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

initializeServer().then(() => {
  app.listen(port, () => {
    log(`Server started on port ${port}`);
    log(`Allowed base paths:\n${ALLOWED_BASE_PATHS.join('\n')}`);
  });
});