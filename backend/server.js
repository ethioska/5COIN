const express = require('express');
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/coinapp', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  lastName: String,
  referralCode: String,
  referredBy: { type: String, default: null },
  coins: {
    nc: { type: Number, default: 0 },
    sc: { type: Number, default: 0 },
    gc: { type: Number, default: 0 },
    dc: { type: Number, default: 0 },
    ska: { type: Number, default: 0 }
  },
  referrals: { type: Number, default: 0 },
  earned: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  userId: Number,
  type: String, // 'bet', 'swap', 'withdrawal', 'referral'
  details: Object,
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// Telegram Bot Setup
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Routes

// Get user data
app.get('/api/user/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user coins
app.post('/api/user/:userId/coins', async (req, res) => {
  try {
    const { coinType, amount } = req.body;
    const user = await User.findOneAndUpdate(
      { userId: req.params.userId },
      { $inc: { [`coins.${coinType}`]: amount } },
      { new: true }
    );
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle coin swap
app.post('/api/swap', async (req, res) => {
  try {
    const { userId, fromCoin, toCoin, amount } = req.body;
    
    // Calculate exchange
    const exchangeRates = {
      nc: { sc: 10, gc: 100, dc: 1000, ska: 10000 },
      sc: { nc: 0.1, gc: 10, dc: 100, ska: 1000 },
      gc: { nc: 0.01, sc: 0.1, dc: 10, ska: 100 },
      dc: { nc: 0.001, sc: 0.01, gc: 0.1, ska: 10 },
      ska: { nc: 0.0001, sc: 0.001, gc: 0.01, dc: 0.1 }
    };
    
    const transactionFee = 0.006; // 0.6%
    const fee = amount * transactionFee;
    const rate = exchangeRates[fromCoin][toCoin];
    const received = (amount - fee) * rate;
    
    // Update user balance
    const user = await User.findOne({ userId });
    if (user.coins[fromCoin] < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    user.coins[fromCoin] -= amount;
    user.coins[toCoin] += received;
    await user.save();
    
    // Record transaction
    const transaction = new Transaction({
      userId,
      type: 'swap',
      details: { fromCoin, toCoin, amount, received, fee }
    });
    await transaction.save();
    
    res.json({ success: true, received, fee, newBalance: user.coins });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle bet
app.post('/api/bet', async (req, res) => {
  try {
    const { userId, coinType, amount, avatar } = req.body;
    
    const user = await User.findOne({ userId });
    if (user.coins[coinType] < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Simulate bet outcome (50% chance to win)
    const win = Math.random() > 0.5;
    let result;
    
    if (win) {
      const winAmount = amount * 1.8; // 80% profit on win
      user.coins[coinType] += winAmount;
      result = { win: true, amount: winAmount };
    } else {
      user.coins[coinType] -= amount;
      result = { win: false, amount: -amount };
    }
    
    await user.save();
    
    // Record transaction
    const transaction = new Transaction({
      userId,
      type: 'bet',
      details: { coinType, amount, avatar, result }
    });
    await transaction.save();
    
    res.json({ success: true, result, newBalance: user.coins });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle withdrawals
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, coinType, amount, method, details } = req.body;
    
    const user = await User.findOne({ userId });
    if (user.coins[coinType] < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Calculate ETB value and fee
    const coinValues = {
      nc: 2.00,    // 0.01 NC ≈ 2 ETB
      sc: 2000.00, // 0.001 SC ≈ 2 ETB
      gc: 20000.00, // 0.0001 GC ≈ 2 ETB
      dc: 200000.00, // 0.00001 DC ≈ 2 ETB
      ska: 2000000.00 // 0.000001 SKA ≈ 2 ETB
    };
    
    const etbValue = amount * coinValues[coinType];
    const fee = etbValue >= 25 ? 2 : etbValue * 0.08;
    const received = etbValue - fee;
    
    // Update user balance
    user.coins[coinType] -= amount;
    await user.save();
    
    // Record transaction
    const transaction = new Transaction({
      userId,
      type: 'withdrawal',
      details: { coinType, amount, method, details, etbValue, fee, received }
    });
    await transaction.save();
    
    // In a real app, you would integrate with payment API here
    // For now, we'll just simulate the withdrawal
    
    res.json({ 
      success: true, 
      message: `Withdrawal request for ${received.toFixed(2)} ETB submitted`,
      received,
      fee
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle referral code usage
app.post('/api/referral', async (req, res) => {
  try {
    const { userId, referralCode } = req.body;
    
    // Find the user who owns this referral code
    const referrer = await User.findOne({ referralCode });
    if (!referrer) {
      return res.status(400).json({ error: 'Invalid referral code' });
    }
    
    // Check if user was already referred
    const user = await User.findOne({ userId });
    if (user.referredBy) {
      return res.status(400).json({ error: 'Already used a referral code' });
    }
    
    // Update both users
    user.referredBy = referralCode;
    await user.save();
    
    referrer.referrals += 1;
    referrer.earned += 0.0005;
    referrer.coins.nc += 0.0005;
    await referrer.save();
    
    // Record transaction
    const transaction = new Transaction({
      userId: referrer.userId,
      type: 'referral',
      details: { referredUserId: userId, bonus: 0.0005 }
    });
    await transaction.save();
    
    res.json({ success: true, bonus: 0.0005 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Telegram Bot Commands
bot.onText(/\/start(.+)?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const referralCode = match[1] ? match[1].trim() : null;
  
  try {
    // Check if user exists
    let user = await User.findOne({ userId });
    
    if (!user) {
      // Create new user
      user = new User({
        userId,
        username: msg.from.username,
        firstName: msg.from.first_name,
        lastName: msg.from.last_name,
        referralCode: `5COIN-${userId.toString(16).toUpperCase()}`,
        coins: { nc: 0, sc: 0, gc: 0, dc: 0, ska: 0 }
      });
      
      // Handle referral if provided
      if (referralCode) {
        const referrer = await User.findOne({ referralCode });
        if (referrer) {
          user.referredBy = referralCode;
          referrer.referrals += 1;
          referrer.earned += 0.0005;
          referrer.coins.nc += 0.0005;
          await referrer.save();
        }
      }
      
      await user.save();
      
      bot.sendMessage(chatId, `Welcome to 5COIN! Your referral code: ${user.referralCode}`);
    } else {
      bot.sendMessage(chatId, `Welcome back to 5COIN! Your balance: ${user.coins.nc} NC`);
    }
    
    // Send game link
    bot.sendMessage(chatId, 'Click the button below to play the game!', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Play Game', web_app: { url: process.env.WEB_APP_URL } }]
        ]
      }
    });
    
  } catch (error) {
    console.error('Error handling /start command:', error);
    bot.sendMessage(chatId, 'Sorry, there was an error. Please try again.');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
