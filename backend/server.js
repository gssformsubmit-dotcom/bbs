require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const os = require('os');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

app.use(express.static(path.join(__dirname, 'frontend')));
app.get('/', (req, res) => {
  res.redirect('/main.html');
});

// 1. MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Atlas Connected Successfully!'))
  .catch(err => console.error('MongoDB Error:', err));


const studentSchema = new mongoose.Schema({
  timestamp: { type: String, default: '' },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  fullName: { type: String, required: true, trim: true },
  contactCall: { type: String, required: true, trim: true },
  contactWhatsapp: { type: String, trim: true },
  course: { type: String, trim: true },
  year: { type: String, trim: true },
  rollNumber: { type: String, required: true, unique: true, trim: true, index: true },
  examCenter: { type: String, trim: true },
  examDate: { type: String, trim: true },
  examShift: { type: String, trim: true },
  pickupPoint: { type: String, trim: true },
  utrNumber: { type: String, trim: true },
  paymentScreenshot: { type: String, trim: true },
  declaration: { type: String, trim: true },
  password: { type: String, default: null },
  isActivated: { type: Boolean, default: false },
  otp: { type: String, default: null },
  otpExpires: { type: Date, default: null },
  lastOtpSentAt: { type: Date, default: null },
  paymentStatus: { type: String, default: 'Pending' },
  busAllocated: { type: String, default: 'Not Assigned' },
  seatNumber: { type: String, default: 'Unassigned' },
  reportingTime: { type: String, default: '06:30 AM' },
  busLeaderName: { type: String, default: 'Coordinator Desk' },
  busLeaderContact: { type: String, default: '9999999999' },
  customEdited: { type: [String], default: [] }
}, { timestamps: true });

const Student = mongoose.model('Student', studentSchema);

// 3. Email Quota Tracker Schema
const emailQuotaSchema = new mongoose.Schema({
  date: { type: String, unique: true },
  counts: { type: Map, of: Number, default: {} }
});
const EmailQuota = mongoose.model('EmailQuota', emailQuotaSchema);

// Transporter Pool Initialization
const mailAccounts = [
  { id: 'acc1', user: process.env.GMAIL_USER_1, pass: process.env.GMAIL_PASS_1 },
  { id: 'acc2', user: process.env.GMAIL_USER_2, pass: process.env.GMAIL_PASS_2 },
  { id: 'acc3', user: process.env.GMAIL_USER_3, pass: process.env.GMAIL_PASS_3 }
].filter(a => Boolean(a.user) && Boolean(a.pass));

const transporters = mailAccounts.map(acc => ({
  id: acc.id,
  user: acc.user,
  transporter: nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    family: 4, // 👈 सबसे ज़रूरी: Force IPv4 (IPv6 हैंग नहीं होगा)
    auth: { user: acc.user, pass: acc.pass },
    connectionTimeout: 5000,
    tls: {
      rejectUnauthorized: false
    }
  })
}));

let globalEmailCounter = 0;

async function sendRotationalOTP(toEmail, studentName, otp) {
  const webhookUrl = process.env.OTP_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('OTP_WEBHOOK_URL is not set in environment variables');
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: toEmail,
      name: studentName,
      otp: otp
    })
  });

  const resData = await response.json().catch(() => ({}));
  if (!response.ok || resData.success === false) {
    throw new Error(resData.error || 'Failed to dispatch OTP via Google Apps Script');
  }

  console.log(`✉️ [INBOX DISPATCH] OTP sent to: ${toEmail} via Google Apps Script Service!`);
  return true;
}

// 4. API: Check Status (Email Verification Step)
app.post('/api/auth/check-status', async (req, res) => {
  try {
    const email = req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : '';
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    const student = await Student.findOne({ email });
    if (!student) {
      return res.status(404).json({ success: false, message: 'Email not registered. Please book via Google Form first.' });
    }

    if (!student.isActivated || !student.password) {
      if (student.lastOtpSentAt && (Date.now() - new Date(student.lastOtpSentAt).getTime()) < 30 * 1000) {
        const remaining = Math.ceil((30 * 1000 - (Date.now() - new Date(student.lastOtpSentAt).getTime())) / 1000);
        return res.status(429).json({ success: false, message: `Please wait ${remaining} seconds before requesting a new OTP.` });
      }

      const generatedOtp = String(Math.floor(100000 + Math.random() * 900000));

      // PEHLE EMAIL BHEJEIN
      await sendRotationalOTP(student.email, student.fullName, generatedOtp);

      // EMAIL SAFAL HONE PAR HI DATABASE MEIN COOLDOWN SAVE KAREIN
      student.otp = generatedOtp;
      student.otpExpires = new Date(Date.now() + 10 * 60 * 1000);
      student.lastOtpSentAt = new Date();
      await student.save();

      return res.json({ success: true, status: 'NEEDS_ACTIVATION', message: 'OTP sent to your registered email.' });
    }

    return res.json({ success: true, status: 'HAS_PASSWORD', message: 'Enter your password.' });
  } catch (err) {
    console.error('Check status error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. API: Verify OTP Only
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const email = req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : '';
    const otp = req.body && req.body.otp ? String(req.body.otp).trim() : '';

    const student = await Student.findOne({ email });
    if (!student || student.otp !== otp || student.otpExpires < new Date()) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP code.' });
    }

    res.json({ success: true, message: 'OTP verified successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. API: Set Password
app.post('/api/auth/set-password', async (req, res) => {
  try {
    const email = req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : '';
    const otp = req.body && req.body.otp ? String(req.body.otp).trim() : '';
    const password = req.body && req.body.password ? String(req.body.password).trim() : '';

    const student = await Student.findOne({ email });
    if (!student || student.otp !== otp || student.otpExpires < new Date()) {
      return res.status(400).json({ success: false, message: 'Session expired. Please request a fresh OTP.' });
    }

    student.password = await bcrypt.hash(password, 10);
    student.isActivated = true;
    student.otp = null;
    student.otpExpires = null;
    await student.save();

    const token = jwt.sign({ id: student._id, roll: student.rollNumber }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, message: 'Password set successfully!', token, student });
  } catch (err) {
    console.error('Set password error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. API: Forgot Password Request (With 30s Cooldown)
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const email = req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : '';
    const student = await Student.findOne({ email });
    if (!student) return res.status(404).json({ success: false, message: 'Student email not found.' });

    if (student.lastOtpSentAt && (Date.now() - new Date(student.lastOtpSentAt).getTime()) < 30 * 1000) {
      const remaining = Math.ceil((30 * 1000 - (Date.now() - new Date(student.lastOtpSentAt).getTime())) / 1000);
      return res.status(429).json({ success: false, message: `Please wait ${remaining}s before requesting again.` });
    }

    const generatedOtp = String(Math.floor(100000 + Math.random() * 900000));

    // PEHLE EMAIL BHEJEIN
    await sendRotationalOTP(student.email, student.fullName, generatedOtp);

    // EMAIL DISPATCH SAFAL HONE PAR HI SAVE
    student.otp = generatedOtp;
    student.otpExpires = new Date(Date.now() + 10 * 60 * 1000);
    student.lastOtpSentAt = new Date();
    await student.save();

    res.json({ success: true, message: 'Reset OTP has been sent to your email.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. API: Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const email = req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : '';
    const password = req.body ? String(req.body.password).trim() : '';

    const student = await Student.findOne({ email });
    if (!student || !student.password) {
      return res.status(400).json({ success: false, message: 'Invalid credentials or inactive account.' });
    }

    const isMatch = await bcrypt.compare(password, student.password);
    if (!isMatch) return res.status(400).json({ success: false, message: 'Incorrect password entered.' });

    const token = jwt.sign({ id: student._id, roll: student.rollNumber }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, message: 'Login successful!', token, student });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 9. GOOGLE SHEET SYNC ENGINE (Safe 60s Production Interval)
const TEST_SHEET_ID = '1exeHyeZlsNcU9PPuJjU4c2mu17Ce94dAMxTYfQOACTI';

function parseCSVLine(text) {
  let p = '';
  let inQuotes = false;
  const result = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { p += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(p);
      p = '';
    } else {
      p += ch;
    }
  }
  result.push(p);
  return result;
}

function cleanStr(v, fallback = '') {
  if (v !== undefined && v !== null) {
    const str = String(v).trim();
    if (str.length > 0) return str;
  }
  return fallback;
}

function formatPaymentStatus(raw) {
  const upper = cleanStr(raw).toUpperCase();
  if (upper.includes('SUCCESS') || upper.includes('VERIFIED')) return 'Verified';
  if (upper.includes('REJECT')) return 'Rejected';
  return 'Pending';
}

// 9. MULTI-SHEET SYNC ENGINE (2nd, 3rd, 4th Year Real Sheets)
// 9. MULTI-SHEET SYNC ENGINE (2nd, 3rd, 4th Year Real Sheets)
// 9. MULTI-SHEET SYNC ENGINE (2nd, 3rd, 4th Year Real Sheets)
const SYNC_SHEETS = [
  { year: '2', id: process.env.SHEET_ID_2ND, gid: process.env.SHEET_GID_2ND },
  { year: '3', id: process.env.SHEET_ID_3RD, gid: process.env.SHEET_GID_3RD },
  { year: '4', id: process.env.SHEET_ID_4TH, gid: process.env.SHEET_GID_4TH }
];

async function syncDirectFromSheet() {
  try {
    const editedStudents = await Student.find({ "customEdited.0": { $exists: true } }, { rollNumber: 1, customEdited: 1 });
    const editedMap = new Map();
    editedStudents.forEach(s => editedMap.set(s.rollNumber, new Set(s.customEdited)));

    const bulkOps = [];
    const seenRolls = new Set();

    for (const targetSheet of SYNC_SHEETS) {
      if (!targetSheet.id) continue;
      try {
        const cleanId = String(targetSheet.id).trim();
        const cleanGid = String(targetSheet.gid).trim();

        // 1. Primary: Direct CSV Export
        let csvUrl = `https://docs.google.com/spreadsheets/d/${cleanId}/export?format=csv&gid=${cleanGid}`;
        let response = await fetch(csvUrl, { redirect: 'follow' });

        // 2. Fallback: GViz CSV Export
        if (!response.ok) {
          csvUrl = `https://docs.google.com/spreadsheets/d/${cleanId}/gviz/tq?tqx=out:csv&gid=${cleanGid}`;
          response = await fetch(csvUrl, { redirect: 'follow' });
        }

        // 3. Fallback: Primary Tab (gid=0)
        if (!response.ok) {
          csvUrl = `https://docs.google.com/spreadsheets/d/${cleanId}/export?format=csv&gid=0`;
          response = await fetch(csvUrl, { redirect: 'follow' });
        }

        if (!response.ok) {
          console.warn(`⚠️ [SYNC NOTICE] Sheet Year ${targetSheet.year} HTTP: ${response.status}`);
          continue;
        }

        const csvText = await response.text();
        const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length <= 1) continue;

        const headers = parseCSVLine(lines[0]).map(h => String(h).trim().toLowerCase());
        const idxTime = headers.findIndex(h => h.includes('timestamp'));
        const idxEmail = headers.findIndex(h => h.includes('email'));
        const idxName = headers.findIndex(h => h.includes('name') && !h.includes('leader'));
        const idxCall = headers.findIndex(h => h.includes('call'));
        const idxWhatsapp = headers.findIndex(h => h.includes('whatsapp'));
        const idxCourse = headers.findIndex(h => h.includes('course'));
        const idxRoll = headers.findIndex(h => h.includes('roll') || h.includes('universit'));
        const idxCenter = headers.findIndex(h => h.includes('center') || h.includes('exam center'));
        const idxDate = headers.findIndex(h => h.includes('date'));
        const idxShift = headers.findIndex(h => h.includes('shift'));
        const idxPickup = headers.findIndex(h => h.includes('pick up') || h.includes('pickup'));
        const idxUtr = headers.findIndex(h => h.includes('utr'));
        const idxScreenshot = headers.findIndex(h => h.includes('screenshot') || h.includes('payment s'));
        const idxDecl = headers.findIndex(h => h.includes('declaration'));
        const idxPayment = headers.findIndex(h => (h.includes('payment') || h.includes('verification')) && !h.includes('screenshot'));

        let yearCount = 0;
        for (let i = 1; i < lines.length; i++) {
          const row = parseCSVLine(lines[i]);
          const email = cleanStr(idxEmail !== -1 ? row[idxEmail] : row[1]).toLowerCase();
          const rollNumber = cleanStr(idxRoll !== -1 ? row[idxRoll] : row[6]);

          if (!email || !rollNumber) continue;
          if (rollNumber.length < 6 || rollNumber.includes('Dev') || rollNumber.includes('Raja') || rollNumber.includes('Campus')) continue;
          if (seenRolls.has(rollNumber)) continue;
          seenRolls.add(rollNumber);
          yearCount++;

          const studentEdits = editedMap.get(rollNumber);

          const updateData = {
            examCenter: cleanStr(idxCenter !== -1 ? row[idxCenter] : ''),
            examDate: cleanStr(idxDate !== -1 ? row[idxDate] : ''),
            pickupPoint: cleanStr(idxPickup !== -1 ? row[idxPickup] : ''),
            paymentScreenshot: cleanStr(idxScreenshot !== -1 ? row[idxScreenshot] : ''),
            declaration: cleanStr(idxDecl !== -1 ? row[idxDecl] : ''),
            course: cleanStr(idxCourse !== -1 ? row[idxCourse] : 'B.Tech CSE'),
            year: targetSheet.year,
            paymentStatus: formatPaymentStatus(idxPayment !== -1 ? row[idxPayment] : 'SUCCESS')
          };

          if (!studentEdits || !studentEdits.has('fullName')) updateData.fullName = cleanStr(idxName !== -1 ? row[idxName] : '');
          if (!studentEdits || !studentEdits.has('contactCall')) updateData.contactCall = cleanStr(idxCall !== -1 ? row[idxCall] : '');
          if (!studentEdits || !studentEdits.has('contactWhatsapp')) updateData.contactWhatsapp = cleanStr(idxWhatsapp !== -1 ? row[idxWhatsapp] : '');
          if (!studentEdits || !studentEdits.has('email')) updateData.email = email;
          if (!studentEdits || !studentEdits.has('examShift')) updateData.examShift = cleanStr(idxShift !== -1 ? row[idxShift] : '');
          if (!studentEdits || !studentEdits.has('utrNumber')) updateData.utrNumber = cleanStr(idxUtr !== -1 ? row[idxUtr] : '');

          const insertOnlyData = {
            timestamp: cleanStr(idxTime !== -1 ? row[idxTime] : ''),
            password: null,
            isActivated: false,
            busAllocated: 'Not Assigned',
            seatNumber: 'Unassigned',
            reportingTime: '06:30 AM',
            busLeaderName: 'Coordinator Desk',
            busLeaderContact: '9999999999'
          };

          bulkOps.push({
            updateOne: {
              filter: { rollNumber: rollNumber },
              update: {
                $set: updateData,$setOnInsert: insertOnlyData
              },
              upsert: true
            }
          });
        }
        console.log(`📑 [SYNC] Year ${targetSheet.year} Sheet read: ${yearCount} students found.`);
      } catch (sheetErr) {
        console.warn(`⚠️ [SYNC] Year ${targetSheet.year} failed:`, sheetErr.message);
      }
    }

    if (bulkOps.length > 0) {
      await Student.bulkWrite(bulkOps);
      console.log(`✅ [SYNC COMPLETE] Total ${bulkOps.length} students synchronized to MongoDB Atlas.`);
    }
  } catch (err) {
    console.error('Multi-Sheet Sync Error:', err.message);
  }
}

// A. Live Sync Endpoint: Fetch latest details of current student
// A. Live Sync Endpoint
app.get('/api/student/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const student = await Student.findOne({
      $or: [{ _id: mongoose.Types.ObjectId.isValid(decoded.id) ? decoded.id : null }, { rollNumber: decoded.roll }]
    });

    if (!student) return res.status(404).json({ success: false, message: 'Student record not found' });
    res.json({ success: true, student });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid token session' });
  }
});

// B. Profile Update Endpoint
app.put('/api/student/update-profile', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { fullName, contactCall, contactWhatsapp, email, utrNumber, examShift } = req.body;

    let student = await Student.findOne({ 
      $or: [{ _id: mongoose.Types.ObjectId.isValid(decoded.id) ? decoded.id : null }, { rollNumber: decoded.roll }] 
    });

    if (!student) return res.status(404).json({ success: false, message: 'Student record not found in MongoDB' });

    const changedFields = [];
    if (fullName && fullName.trim() !== student.fullName) {
      student.fullName = fullName.trim();
      changedFields.push('fullName');
    }
    if (contactCall && contactCall.trim() !== student.contactCall) {
      student.contactCall = contactCall.trim();
      changedFields.push('contactCall');
    }
    if (contactWhatsapp && contactWhatsapp.trim() !== student.contactWhatsapp) {
      student.contactWhatsapp = contactWhatsapp.trim();
      changedFields.push('contactWhatsapp');
    }
    if (email && email.trim().toLowerCase() !== student.email) {
      student.email = email.trim().toLowerCase();
      changedFields.push('email');
    }
    if (utrNumber && utrNumber.trim() !== (student.utrNumber || '')) {
      student.utrNumber = utrNumber.trim();
      changedFields.push('utrNumber');
    }
    if (examShift && examShift.trim() !== student.examShift) {
      student.examShift = examShift.trim();
      changedFields.push('examShift');
    }

    // Lock updated fields
    student.customEdited = Array.from(new Set([...(student.customEdited || []), ...changedFields]));
    await student.save();

    console.log('✅ [MONGODB UPDATED & LOCKED] Roll: ' + student.rollNumber + ' | Changed: ' + changedFields.join(', '));

    // 1. Send instant success response to student (return ensures it's sent only once)
    res.json({ success: true, message: 'Profile successfully updated in database!', student });

    // 2. Background push to Google Apps Script backup sheet (completely detached from res)
    if (process.env.UPDATE_SHEET_WEBHOOK_URL) {
      fetch(process.env.UPDATE_SHEET_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rollNumber: student.rollNumber,
          fullName: student.fullName,
          contactCall: student.contactCall,
          contactWhatsapp: student.contactWhatsapp,
          email: student.email,
          utrNumber: student.utrNumber,
          examShift: student.examShift,
          changedFields: changedFields,
          updatedAt: new Date().toLocaleString()
        })
      })
      .then(r => r.json())
      .then(resData => console.log('📊 [BACKUP SHEET UPDATED WITH BOLD]:', resData))
      .catch(e => console.warn('Webhook log notice:', e.message));
    }

  } catch (err) {
    console.error('Update profile error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
});

// 10. Server Boot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 BBS Server Running on Port ${PORT}!`);
  console.log(`👉 http://localhost:${PORT}/main.html`);
  console.log(`==================================================\n`);

  syncDirectFromSheet();
  setInterval(syncDirectFromSheet, 60 * 1000); // Production Safe Interval
});