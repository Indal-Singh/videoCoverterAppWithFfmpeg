const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const port = 5025;

// Enable CORS
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for video upload
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueId = uuidv4();
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueId}-${Date.now()}${ext}`);
    }
});

const upload = multer({ storage: storage });

// Schedule cleanup of old files (every 15 minutes)
cron.schedule('*/15 * * * *', () => {
    const uploadsDir = 'uploads';
    if (fs.existsSync(uploadsDir)) {
        fs.readdir(uploadsDir, (err, files) => {
            if (err) throw err;
            files.forEach(file => {
                const filePath = path.join(uploadsDir, file);
                fs.unlink(filePath, (err) => {
                    if (err) console.error(`Error deleting file ${file}:`, err);
                });
            });
        });
    }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected with ID:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Video conversion endpoint
app.post('/convert', upload.array('videos', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: 'No files uploaded' });
        }

        const targetSize = parseInt(req.body.targetSize) || 10; // Default to 10MB
        const socketId = req.body.socketId;
        const socket = io.sockets.sockets.get(socketId);

        if (!socket) {
            return res.status(400).json({ success: false, error: 'Socket connection not found' });
        }

        const results = [];
        let currentFile = 1;
        const totalFiles = req.files.length;

        for (const file of req.files) {
            const fileId = file.originalname.replace(/[^a-zA-Z0-9]/g, '_');
            const outputPath = path.join(__dirname, 'uploads', `converted-${fileId}.mp4`);
            
            // Emit conversion start event
            socket.emit('conversion-start', {
                fileId,
                fileName: file.originalname,
                currentFile,
                totalFiles
            });

            try {
                // Get video duration
                const duration = await new Promise((resolve, reject) => {
                    ffmpeg.ffprobe(file.path, (err, metadata) => {
                        if (err) reject(err);
                        else resolve(metadata.format.duration);
                    });
                });

                // Calculate target bitrate (in kbps)
                const targetBitrate = Math.floor((targetSize * 8192) / duration);

                // Convert video
                await new Promise((resolve, reject) => {
                    let lastProgress = 0;
                    
                    ffmpeg(file.path)
                        .outputOptions([
                            `-b:v ${targetBitrate}k`,
                            '-c:v libx264',
                            '-preset medium',
                            '-c:a aac',
                            '-b:a 128k'
                        ])
                        .on('progress', (progress) => {
                            if (progress.percent) {
                                const currentProgress = Math.floor(progress.percent);
                                if (currentProgress > lastProgress) {
                                    lastProgress = currentProgress;
                                    socket.emit('conversion-progress', {
                                        fileId,
                                        fileName: file.originalname,
                                        progress: currentProgress,
                                        currentFile,
                                        totalFiles
                                    });
                                }
                            }
                        })
                        .on('end', () => {
                            const downloadUrl = `/download/${path.basename(outputPath)}`;
                            results.push({
                                originalName: file.originalname,
                                downloadUrl: downloadUrl
                            });
                            
                            // Emit completion event with download URL
                            socket.emit('conversion-complete', {
                                fileId,
                                fileName: file.originalname,
                                downloadUrl: downloadUrl,
                                currentFile,
                                totalFiles
                            });
                            
                            resolve();
                        })
                        .on('error', (err) => {
                            socket.emit('conversion-error', {
                                fileId,
                                fileName: file.originalname,
                                error: err.message
                            });
                            reject(err);
                        })
                        .save(outputPath);
                });

                // Clean up original file
                fs.unlinkSync(file.path);
                
            } catch (error) {
                console.error(`Error converting file ${file.originalname}:`, error);
                socket.emit('conversion-error', {
                    fileId,
                    fileName: file.originalname,
                    error: error.message
                });
            }
            
            currentFile++;
        }

        // Send final response
        res.json({ 
            success: true, 
            message: 'All files processed',
            results: results
        });

    } catch (error) {
        console.error('Error in conversion process:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Download endpoint
app.get('/download/:filename', (req, res) => {
    const filePath = path.join('uploads', req.params.filename);
    res.download(filePath, (err) => {
        if (err) {
            console.error('Error downloading file:', err);
            res.status(404).send('File not found');
        }
    });
});

httpServer.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 