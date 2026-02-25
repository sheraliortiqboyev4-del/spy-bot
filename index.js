require('dotenv').config();
const { Bot, InputFile } = require('grammy');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http'); // Render uchun server kerak
const mongoose = require('mongoose'); // MongoDB
const { TelegramClient, Api } = require('telegram'); // Userbot uchun
const { StringSession } = require('telegram/sessions'); // Session saqlash
const { NewMessage, EditedMessage, DeletedMessage } = require('telegram/events'); // Userbot events
const input = require('input'); // Kod kiritish uchun (serverda qiyin bo'ladi)

// Konfiguratsiya
const BOT_TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH || './downloads/';
const CONNECTION_FILE = 'connections.json';
const MAX_CACHE_SIZE = 500;
const PORT = process.env.PORT || 3000; // Render portni o'zi beradi
const MONGO_URL = process.env.MONGO_URL; // MongoDB URL

// Telegram API (Userbot uchun) - Telegram Desktop (Windows)
// Bu rasmiy ID, shuning uchun foydalanuvchilar o'zlarinikini yaratishi shart emas.
const API_ID = 2040;
const API_HASH = "b18441a1ff607e10a989891a5462e627";

// MongoDB Schemas
const ConnectionSchema = new mongoose.Schema({
    connectionId: { type: String, required: true, unique: true },
    userId: { type: Number, required: true }
});

const SessionSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    sessionString: { type: String, required: true }
});

const Connection = mongoose.model('Connection', ConnectionSchema);
const UserSession = mongoose.model('Session', SessionSchema);

// Userbot Clientlari (xotirada saqlash)
const userClients = new Map();

// MongoDB ga ulanish
if (MONGO_URL) {
    mongoose.connect(MONGO_URL)
        .then(() => console.log('✅ MongoDB ga muvaffaqiyatli ulandi!'))
        .catch(err => console.error('❌ MongoDB ulanishida xatolik:', err));
} else {
    console.warn('⚠️ MONGO_URL topilmadi! Fayl tizimidan foydalaniladi (ishonchsiz).');
}

// Downloads papkasini yaratish
if (!fs.existsSync(DOWNLOAD_PATH)) {
    fs.mkdirSync(DOWNLOAD_PATH, { recursive: true });
}

// Render uchun oddiy server (Health check)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

if (!BOT_TOKEN) {
    console.error("XATOLIK: .env faylida BOT_TOKEN topilmadi!");
    process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Xabarlar keshi (Map: chat_id -> Map: message_id -> message)
const messageCache = new Map();

// Connection mapping (Map: connection_id -> user_id)
let connectionMap = new Map();

// Logging
function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${message}`;
    console.log(logMessage);
    fs.appendFileSync('bot.log', logMessage + '\n');
}

// Ulanishlarni yuklash
async function loadConnections() {
    if (MONGO_URL) {
        try {
            const connections = await Connection.find({});
            for (const conn of connections) {
                connectionMap.set(conn.connectionId, conn.userId);
            }
            log(`MongoDB dan yuklangan ulanishlar: ${connectionMap.size}`);
        } catch (e) {
            log(`MongoDB dan yuklashda xatolik: ${e.message}`);
        }
    } else if (fs.existsSync(CONNECTION_FILE)) {
        try {
            const data = fs.readFileSync(CONNECTION_FILE, 'utf8');
            const json = JSON.parse(data);
            connectionMap = new Map(Object.entries(json));
            log(`Fayldan yuklangan ulanishlar: ${connectionMap.size}`);
        } catch (e) {
            log(`Ulanishlarni yuklashda xatolik: ${e.message}`);
        }
    }
}

// Ulanishlarni saqlash
async function saveConnections() {
    if (MONGO_URL) {
        // MongoDB ga asinxron saqlaymiz (xalaqit bermasligi uchun)
        // Buni optimallashtirish mumkin, lekin hozircha har safar saqlaymiz
        // Real loyihada faqat o'zgarganini saqlash kerak
        try {
            // Bulk write qilish yaxshiroq
            const ops = [];
            for (const [connId, userId] of connectionMap.entries()) {
                ops.push({
                    updateOne: {
                        filter: { connectionId: connId },
                        update: { $set: { userId: userId } },
                        upsert: true
                    }
                });
            }
            if (ops.length > 0) {
                await Connection.bulkWrite(ops);
            }
        } catch (e) {
            log(`MongoDB ga saqlashda xatolik: ${e.message}`);
        }
    }

    // Har doim faylga ham saqlab qo'yamiz (backup sifatida)
    try {
        const obj = Object.fromEntries(connectionMap);
        fs.writeFileSync(CONNECTION_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        log(`Ulanishlarni saqlashda xatolik: ${e.message}`);
    }
}

// Sessionlarni yuklash va Userbotlarni ishga tushirish
async function loadSessions() {
    if (!API_ID || !API_HASH) return;

    try {
        let sessions = [];
        if (MONGO_URL) {
            sessions = await UserSession.find({});
        } else {
            // Fayldan o'qish (agar kerak bo'lsa, lekin hozircha MongoDB asosiy)
            // Hozircha faqat MongoDB
        }

        for (const session of sessions) {
            try {
                const client = new TelegramClient(new StringSession(session.sessionString), API_ID, API_HASH, {
                    connectionRetries: 5,
                });
                
                await client.connect(); // Ulanish
                
                // Agar muvaffaqiyatli ulansa
                startUserbot(session.userId, client);
                log(`Userbot qayta tiklandi: ${session.userId}`);
            } catch (e) {
                log(`Sessionni tiklashda xatolik (${session.userId}): ${e.message}`);
            }
        }
    } catch (e) {
        log(`Sessionlarni yuklashda xatolik: ${e.message}`);
    }
}

// Bot ishga tushganda yuklash
loadConnections().then(() => {
    log("Ulanishlar yuklandi.");
    loadSessions().then(() => { // Sessionlarni ham yuklaymiz
        log("Sessionlar tekshirildi.");
    });
});

// Keshga qo'shish
function addToCache(ctx) {
    const chatId = ctx.chat.id;
    const messageId = ctx.msg.message_id;

    if (!messageCache.has(chatId)) {
        messageCache.set(chatId, new Map());
    }

    const chatCache = messageCache.get(chatId);

    // Kesh hajmini tekshirish
    if (chatCache.size >= MAX_CACHE_SIZE) {
        const firstKey = chatCache.keys().next().value;
        chatCache.delete(firstKey);
    }

    chatCache.set(messageId, ctx.msg);
}

// Keshdan olish
function getFromCache(chatId, messageId) {
    if (messageCache.has(chatId)) {
        return messageCache.get(chatId).get(messageId);
    }
    return null;
}

// User ID ni connection ID dan topish
function getUserIdFromConnection(connectionId) {
    if (connectionMap.has(connectionId)) {
        return connectionMap.get(connectionId);
    }
    // Fallback
    try {
        return parseInt(connectionId.split(':')[0]);
    } catch (e) {
        return null;
    }
}

// Admin (biznes egasi) ga xabar yuborish
async function notifyAdmin(userId, text, filePath = null) {
    try {
        if (filePath) {
            await bot.api.sendDocument(userId, new InputFile(filePath), { caption: text });
        } else {
            await bot.api.sendMessage(userId, text, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        log(`Adminga (${userId}) xabar yuborishda xatolik: ${e.message}`);
    }
}

// Userbot yaratish funksiyasi
async function createUserbot(userId, sessionStr) {
    if (!API_ID || !API_HASH) {
        log("API_ID yoki API_HASH topilmadi! Userbot ishlamaydi.");
        return null;
    }

    const stringSession = new StringSession(sessionStr || "");
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
        connectionRetries: 5,
    });

    // Clientni saqlab qo'yamiz
    userClients.set(userId, client);

    // Event handler (Userbot uchun)
    client.addEventHandler(async (event) => {
        // Bu yerda userbot logikasi bo'ladi (xuddi business message kabi)
        // Lekin grammY eventlaridan farq qiladi
        // Hozircha oddiy log chiqaramiz
        // log(`Userbot (${userId}) event: ${event.className}`);
    });

    return client;
}

// Start buyrug'i
bot.command('start', async (ctx) => {
    // Obuna tekshirish
    if (!await isSubscribed(ctx.from.id)) {
        const channelLink = `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}`;
        const txt = `⚠️ <b>Diqqat!</b>\n\nBotdan to'liq foydalanish uchun bizning kanalga obuna bo'lishingiz shart!\n\nKanal: ${REQUIRED_CHANNEL}`;

        return ctx.reply(txt, {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "➕ Obuna bo'lish", url: channelLink }],
                    [{ text: "✅ Tekshirish", callback_data: "check_sub" }]
                ]
            }
        });
    }

    const firstName = escapeHTML(ctx.from.first_name);

    // Rasm URL (Siz xohlagan rasmga o'zgartirishingiz mumkin)
    // Telegram logotipi yoki oldingi rasm
    const photoUrl = "AgACAgIAAxkBAAM4aZyac4hPwl6nHjPTbHoNh9PMelYAAjERaxvvFelIfubzN0vEdxIBAAMCAAN5AAM6BA";

    const caption = `Salom, <b>${firstName}</b>! Bot ishga tushdi.\n` +
        `Siz botdan ikki xil usulda foydalanishingiz mumkin:\n\n` +
        `1️⃣ <b>Telegram Business (Tavsiya etiladi):</b>\n` +
        `• Faqat Premium foydalanuvchilar uchun.\n` +
        `• Xavfsiz va tezkor.\n` +
        `• "Biznesga ulash" tugmasini bosing.\n\n` +
        `2️⃣ <b>Telefon raqam orqali (Userbot):</b>\n` +
        `• Barcha foydalanuvchilar uchun.\n` +
        `• Telefon raqamingiz orqali kirasiz.\n` +
        `• ⚠️ <b>Diqqat:</b> Bu usul xavfsizlik nuqtai nazaridan kamroq tavsiya etiladi.`;

    // Telegram Business ulanish linki
    const botUsername = ctx.me.username;
    const businessLink = `https://t.me/${botUsername}?start=business`;

    try {
        await ctx.replyWithPhoto(photoUrl, {
            caption: caption,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "💼 Biznesga ulash (Premium)", url: businessLink }],
                    [{ text: "📱 Telefon raqam orqali kirish", callback_data: "login_phone" }],
                    [{ text: "📹 Bot ishlashini ko'rish", callback_data: "demo_video" }]
                ]
            }
        });
    } catch (e) {
        log(`Start buyrug'ida xatolik: ${e.message}`);
        // Agar rasm yuborishda xatolik bo'lsa (masalan file_id eskirgan), matnni o'zini yuboramiz
        await ctx.reply(caption, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "📹 Bot ishlashini ko'rish", callback_data: "demo_video" }
                    ]
                ]
            }
        });
    }
});

// Login jarayoni (Telefon raqam)
bot.callbackQuery('login_phone', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Iltimos, telefon raqamingizni xalqaro formatda yuboring (masalan: +998901234567):");
    // Bu yerda state management kerak bo'ladi (foydalanuvchi hozir nima kutyapti?)
    // Hozircha oddiy session object ishlatamiz
    userClients.set(ctx.from.id, { step: 'phone' });
});

// Matnli xabarlar (Login jarayoni uchun)
bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id;
    const userState = userClients.get(userId);

    // Agar login jarayonida bo'lmasa, oddiy xabar deb qabul qilamiz
    if (!userState || !userState.step) return;

    const text = ctx.message.text || "";

    if (userState.step === 'phone') {
        // Telefon raqam keldi
        userState.phone = text.replace(/[^0-9+]/g, '');

        try {
            await ctx.reply("🔄 Ulanmoqda... Iltimos kuting.");

            const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
                connectionRetries: 5,
                deviceModel: "SpyBot User",
                appVersion: "1.0.0",
            });

            await client.connect();

            const { phoneCodeHash } = await client.sendCode({
                apiId: API_ID,
                apiHash: API_HASH,
            }, userState.phone);

            userState.client = client;
            userState.phoneCodeHash = phoneCodeHash;
            userState.step = 'code';
            userClients.set(userId, userState);

            await ctx.reply(`✅ Kod yuborildi!\n\n⚠️ <b>DIQQAT:</b> Telegram kodni bloklamasligi uchun, kodni raqamlar orasida nuqta qo'yib yuboring.\n\nMasalan, agar kod <b>12345</b> bo'lsa, siz <b>1.2.3.4.5</b> deb yozing.`);
        } catch (e) {
            log(`Kod yuborishda xatolik (${userId}): ${e.message}`);
            await ctx.reply(`❌ Xatolik yuz berdi: ${e.message}\n\nQayta urinib ko'ring /start`);
            userClients.delete(userId);
        }

    } else if (userState.step === 'code') {
        // Kod keldi
        // Barcha belgilarni olib tashlaymiz (faqat raqamlar qoladi)
        const code = text.replace(/[^0-9]/g, ''); // Barcha raqam bo'lmagan belgilarni (nuqta, bo'sh joy) tozalash

        if (!code) {
            return ctx.reply("❌ Iltimos, kodni to'g'ri yozing (faqat raqamlar).");
        }

        try {
            await ctx.reply(`🔄 Kod tekshirilmoqda (${code})...`);

            await userState.client.invoke(new Api.auth.SignIn({
                phoneNumber: userState.phone,
                phoneCodeHash: userState.phoneCodeHash,
                phoneCode: code,
            }));

            const session = userState.client.session.save();

            // Sessionni MongoDB ga saqlash
            if (MONGO_URL) {
                await UserSession.updateOne(
                    { userId: userId },
                    { sessionString: session },
                    { upsert: true }
                );
            }

            await ctx.reply("✅ Muvaffaqiyatli ulandingiz!\nEndi bot sizning nomingizdan ishlaydi.");

            // Clientni ishga tushirish (eventlarni tinglash)
            startUserbot(userId, userState.client);

            userClients.delete(userId); // State ni tozalash (lekin client xotirada qoladi)

        } catch (e) {
            if (e.message.includes('SESSION_PASSWORD_NEEDED')) {
                userState.step = 'password';
                userState.code = code; // Kodni saqlab turamiz (garchi signIn da ishlatilgan bo'lsa ham)
                userClients.set(userId, userState);
                await ctx.reply("🔐 Ikki bosqichli tekshiruv (2FA) parolini kiriting:");
            } else {
                log(`Kirishda xatolik (${userId}): ${e.message}`);
                await ctx.reply(`❌ Xatolik: ${e.message}\n\nQayta urinib ko'ring /start`);
                userClients.delete(userId);
            }
        }
    } else if (userState.step === 'password') {
        // 2FA Parol keldi
        try {
            await ctx.reply("🔄 Parol tekshirilmoqda...");

            await userState.client.signIn({
                password: text,
            });

            const session = userState.client.session.save();

            // Sessionni MongoDB ga saqlash
            if (MONGO_URL) {
                await UserSession.updateOne(
                    { userId: userId },
                    { sessionString: session },
                    { upsert: true }
                );
            }

            await ctx.reply("✅ Muvaffaqiyatli ulandingiz! (2FA bilan)\nEndi bot sizning nomingizdan ishlaydi.");

            startUserbot(userId, userState.client);
            userClients.delete(userId);

        } catch (e) {
            log(`Parol xatosi (${userId}): ${e.message}`);
            await ctx.reply(`❌ Parol noto'g'ri yoki xatolik: ${e.message}`);
        }
    }
});

// Userbotni ishga tushirish va eventlarni tinglash
async function startUserbot(userId, client) {
    userClients.set(userId, client);
    
    // Yangi xabarlar (Keshga saqlash va Timer xabarlarni ushlash)
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;
            if (!message) return;
            
            const chatId = message.chatId ? message.chatId.toString() : null;
            if (!chatId) return;

            // Keshga saqlash (xuddi business message kabi)
            // Lekin bu yerda message object farq qiladi (GramJS object)
            // Biz uni oddiy objectga o'xshatib saqlashimiz kerak yoki o'zini saqlaymiz
            // O'zini saqlash qulayroq
            if (!messageCache.has(chatId)) {
                messageCache.set(chatId, new Map());
            }
            const chatCache = messageCache.get(chatId);
            if (chatCache.size >= MAX_CACHE_SIZE) {
                const firstKey = chatCache.keys().next().value;
                chatCache.delete(firstKey);
            }
            chatCache.set(message.id, message);

            // Timer (TTL) yoki Protected content tekshirish
            // GramJS da: message.ttlSeconds
            // Yoki media protected bo'lsa
            if (message.ttlSeconds || (message.media && message.media.ttlSeconds)) {
                // Timer xabar! Yuklab olamiz.
                try {
                    const buffer = await client.downloadMedia(message, {
                        outputFile: DOWNLOAD_PATH
                    });
                    
                    if (buffer) {
                        message.downloadedFilePath = buffer; // Path string qaytadi
                        // Keshni yangilaymiz
                        chatCache.set(message.id, message);
                        // Userga bildirish shart emas, faqat o'chirilganda kerak
                    }
                } catch (e) {
                    log(`Userbot: Timer media yuklashda xatolik: ${e.message}`);
                }
            }

            // Reply tekshirish (Agar timer xabarga reply qilingan bo'lsa)
            if (message.replyTo) {
                const replyId = message.replyTo.replyToMsgId;
                if (replyId) {
                    // Keshdan qidiramiz
                    let replyMsg = chatCache.get(replyId);
                    
                    // Agar keshda yo'q bo'lsa, yuklab olishga harakat qilamiz
                    if (!replyMsg) {
                        try {
                            const messages = await client.getMessages(message.chatId, { ids: [replyId] });
                            if (messages && messages.length > 0) {
                                replyMsg = messages[0];
                                // Keshga qo'shamiz
                                chatCache.set(replyId, replyMsg);
                            }
                        } catch (e) { }
                    }

                    // Agar topilsa va media bo'lsa
                    if (replyMsg && (replyMsg.media || replyMsg.ttlSeconds)) {
                        // Agar hali yuklanmagan bo'lsa
                        if (!replyMsg.downloadedFilePath) {
                             try {
                                const buffer = await client.downloadMedia(replyMsg, {
                                    outputFile: DOWNLOAD_PATH
                                });
                                if (buffer) {
                                    replyMsg.downloadedFilePath = buffer;
                                    chatCache.set(replyId, replyMsg);
                                    
                                    // Adminga (o'ziga) yuborish - "Talabga binoan"
                                    await client.sendMessage("me", { 
                                        message: `🔔 **Talabga binoan (Reply - Userbot):**\n📂 Fayl: ${path.basename(buffer)}`, 
                                        file: buffer 
                                    });
                                }
                            } catch (e) {
                                log(`Userbot: Reply media yuklashda xatolik: ${e.message}`);
                            }
                        } else {
                            // Allaqachon yuklangan bo'lsa
                             await client.sendMessage("me", { 
                                message: `🔔 **Talabga binoan (Reply - Userbot):**\n📂 Fayl: ${path.basename(replyMsg.downloadedFilePath)}`, 
                                file: replyMsg.downloadedFilePath 
                            });
                        }
                    }
                }
            }

        } catch (e) {
            log(`Userbot NewMessage error: ${e.message}`);
        }
    }, new NewMessage({}));

    // Tahrirlangan xabarlar (Generic Handler)
    client.addEventHandler(async (event) => {
        try {
            // Agar event tahrirlangan xabar bo'lsa
            // GramJS da `EditedMessage` constructor xatosi bo'layotgan bo'lsa,
            // biz `event` obyekti turini tekshirishimiz mumkin yoki shunchaki
            // agar message mavjud bo'lsa va u keshda bo'lsa, solishtiramiz.

            // Hozircha bu handler barcha eventlarni ushlaydi.
            // Biz faqat `EditMessage` turidagi eventlarni qidiramiz.
            // Yoki oddiygina `event.message` borligini tekshiramiz.

            const message = event.message;
            if (!message || !message.editDate) return; // Faqat tahrirlangan xabarlar

            const chatId = message.chatId ? message.chatId.toString() : null;
            if (!chatId) return;

            const chatCache = messageCache.get(chatId);
            const oldMsg = chatCache ? chatCache.get(message.id) : null;

            if (oldMsg) {
                const oldText = oldMsg.text || oldMsg.message || "(Media)";
                const newText = message.text || message.message || "(Media)";

                // Faqat matn o'zgargan bo'lsa va mazmuni farq qilsa
                if (oldText !== newText) {
                    const txt = `✏️ **Xabar tahrirlandi (Userbot):**\n\n**Eski:**\n${oldText}\n\n**Yangi:**\n${newText}`;
                    await client.sendMessage("me", { message: txt });
                }
            }
            
            // Keshni yangilash
            if (chatCache) {
                chatCache.set(message.id, message);
            }

        } catch (e) {
            // log(`Userbot EditedMessage error: ${e.message}`);
        }
    });


    // O'chirilgan xabarlar
    client.addEventHandler(async (event) => {
        try {
            // DeletedMessage eventida deletedIds bor
            const deletedIds = event.deletedIds;
            const chatId = event.chatId ? event.chatId.toString() : null; // Ba'zan chatId bo'lmasligi mumkin (global delete)
            
            // Agar chatId bo'lmasa, barcha keshlarni qidirish kerak bo'ladi (qiyin)
            // Lekin odatda chatId bo'ladi agar bu channel/group bo'lsa. Private chatda chatId bo'lmasligi mumkin.
            
            if (chatId && messageCache.has(chatId)) {
                const chatCache = messageCache.get(chatId);
                
                for (const msgId of deletedIds) {
                    const oldMsg = chatCache.get(msgId);
                    if (oldMsg) {
                        let txt = `🗑 **Xabar o'chirildi (Userbot):**\n`;
                        const content = oldMsg.text || oldMsg.message || "(Media)";
                        txt += `\n${content}`;

                        if (oldMsg.downloadedFilePath) {
                             await client.sendMessage("me", { 
                                message: txt + `\n\n📂 **Saqlangan fayl:**`, 
                                file: oldMsg.downloadedFilePath 
                            });
                        } else if (oldMsg.media) {
                            // Agar media bo'lsa lekin yuklanmagan bo'lsa (oddiy rasm/video)
                            // Userbot orqali "o'chirilgan" mediani qayta yuklash qiyin, chunki u serverdan o'chgan bo'lishi mumkin.
                            // Lekin agar u keshda bo'lsa (message object), biz uni qayta forward qila olamiz? Yo'q, ID o'chgan.
                            // Faqat oldindan yuklangan bo'lsa (timer/protected) saqlab qolamiz.
                            await client.sendMessage("me", { message: txt + "\n(Media fayl, lekin oldindan yuklanmagan)" });
                        } else {
                            await client.sendMessage("me", { message: txt });
                        }
                    }
                }
            }

        } catch (e) {
             log(`Userbot DeletedMessage error: ${e.message}`);
        }
    }, new DeletedMessage({}));
}

// Demo videosi ID si (Hozircha bo'sh)
let demoVideoId = "BAACAgQAAxkBAAM8aZybtBWFdsxnthgVshMUsbH3BzUAAkkfAAKCfOBQ1m9j7M2sXpg6BA";

// Admin uchun: Video ID sini olish (Vaqtinchalik)
bot.on('message:video', (ctx) => {
    const fileId = ctx.message.video.file_id;
    log(`VIDEO ID (Foydalanuvchi yubordi): ${fileId}`);
    demoVideoId = fileId;
    ctx.reply(`Video ID si qabul qilindi: <code>${fileId}</code>\nEndi "Bot ishlashini ko'rish" tugmasi shu videoni yuboradi.`, { parse_mode: "HTML" });
});

// Demo tugmasi bosilganda
bot.callbackQuery("demo", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        if (demoVideoId && demoVideoId !== "BAACAgIAAxkBAAM6aZydG4_4tK5e5_7j5z5_5z5_5z5") {
            const caption = `<b>Bot faoliyatidan namunalar</b>\n\n` +
                `Videoda: "<b>Taymerli media fayllarni yuklab olish.</b>" Ko'rsatilgan.\n\n` +
                `✅ Suhbatdosh xabarni o‘zgartirganda bildirishnoma yuborish\n` +
                `✅ Suhbatdosh xabarni o‘chirib tashlaganda bildirishnoma yuborish\n\n` +
                `<b>Bot hatto siz oflayn holatda bo‘lsangiz ham ishlaydi!</b>`;

            await ctx.replyWithVideo(demoVideoId, {
                caption: caption,
                parse_mode: "HTML"
            });
        } else {
            await ctx.reply("Hozircha video yuklanmagan. Iltimos, adminga murojaat qiling.");
        }
    } catch (error) {
        log(`Demo video yuborishda xatolik: ${error.message}`);
        await ctx.reply("Videoni yuborishda xatolik yuz berdi.");
    }
});

// Status komandasi
bot.command('status', async (ctx) => {
    const userId = ctx.from.id.toString();
    let isConnected = false;

    for (const [connId, uid] of connectionMap.entries()) {
        if (uid.toString() === userId) {
            isConnected = true;
            break;
        }
    }

    let statusText = "✅ Bot ishlayapti (Node.js).\n";
    if (isConnected) {
        statusText += "🔗 Sizning biznes akkauntingiz ulangan.";
    } else {
        statusText += "⚠️ Sizning biznes akkauntingiz hali ulanmagan yoki bot qayta ishga tushganidan beri yangilanmagan.";
    }

    await ctx.reply(statusText);
});

// Yangi biznes ulanishi
bot.on('business_connection', async (ctx) => {
    const connection = ctx.business_connection;
    log(`Yangi Business connection: ${connection.id} -> User: ${connection.user.id}`);

    connectionMap.set(connection.id, connection.user.id);
    await saveConnections(); // await qo'shildi

    try {
        await bot.api.sendMessage(connection.user.id, "✅ Bot muvaffaqiyatli ulandi! Endi men xabarlarni kuzatib boraman.");
    } catch (e) {
        log(`Xabar yuborishda xatolik: ${e.message}`);
    }
});

// HTML Escape funksiyasi
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Xabar kelganda
bot.on('business_message', async (ctx) => {
    // Keshga saqlash
    addToCache(ctx);

    const msg = ctx.msg;

        // Connection ID ni saqlash (agar yangi bo'lsa)
    if (msg.business_connection_id && !connectionMap.has(msg.business_connection_id)) {
        try {
            const userId = parseInt(msg.business_connection_id.split(':')[0]);
            if (!isNaN(userId)) {
                connectionMap.set(msg.business_connection_id, userId);
                await saveConnections(); // await qo'shildi
            }
        } catch (e) { }
    }

    // Reply logikasi: Agar admin (biznes egasi) xabarga javob bersa
    try {
        const userId = getUserIdFromConnection(msg.business_connection_id);
        log(`Reply tekshiruvi: MsgID=${msg.message_id}, ReplyTo=${msg.reply_to_message ? msg.reply_to_message.message_id : 'null'}, UserID=${userId}, FromID=${msg.from.id}`);

        if (msg.reply_to_message && userId) {
            // Agar biznes egasi (siz) javob berayotgan bo'lsa
            if (msg.from.id === userId) {
                const repliedMsgId = msg.reply_to_message.message_id;
                // Chat ID ni tekshiramiz. Telegram Business da chat ID har xil bo'lishi mumkin.
                // Lekin odatda bitta suhbat uchun bitta chat ID bo'ladi.
                // Muammo shundaki, keshga saqlaganda qaysi chat ID bilan saqlangan?

                const chatId = ctx.chat.id;
                const repliedMsg = getFromCache(chatId, repliedMsgId);

                log(`Keshdan qidirish: ChatID=${chatId}, RepliedMsgID=${repliedMsgId}, Topildimi=${!!repliedMsg}, Fayl bormi=${repliedMsg ? !!repliedMsg.downloadedFilePath : 'false'}`);

                // Agar keshda topilmasa, ehtimol bu xabar bot ishga tushishidan oldin kelgan
                // Yoki kesh tozalanib ketgan.

                if (repliedMsg && repliedMsg.downloadedFilePath) {
                    await notifyAdmin(userId, `🔔 **Talabga binoan (Reply):**\n📂 Fayl: ${path.basename(repliedMsg.downloadedFilePath)}`, repliedMsg.downloadedFilePath);
                    log(`Reply orqali fayl yuborildi: ${userId}`);
                } else if (!repliedMsg) {
                    // Agar keshda yo'q bo'lsa, demak biz bu xabarni ushlamaganmiz.
                    // Yoki bu xabar bot ishga tushishidan oldin kelgan.
                    // Yoki bu xabar oddiy xabar (media emas), shuning uchun biz uni yuklab olmaganmiz.
                    // Agar reply qilingan xabar media bo'lsa va biz uni ushlamagan bo'lsak, endi yuklab olishga harakat qilamiz.

                    const replyMsg = msg.reply_to_message;
                    if (replyMsg.photo || replyMsg.video || replyMsg.video_note || replyMsg.voice || replyMsg.document) {
                        log("Reply qilingan xabar keshda yo'q, lekin media bor. Yuklab olishga harakat qilamiz...");
                        // Lekin bizda faqat message object bor, to'liq context yo'q.
                        // Shuning uchun download funksiyasini chaqirish qiyinroq.
                        // Keling, uni qo'lda "ushlaymiz"

                        // Vaqtinchalik context yaratish (juda oddiy)
                        const fakeCtx = {
                            msg: replyMsg,
                            chat: ctx.chat,
                            api: ctx.api,
                            business_connection: ctx.business_connection
                        };

                        // Keshga qo'shamiz (keyingi safar uchun)
                        // Lekin media yuklash qismi business_message eventida.
                        // Biz uni bu yerdan chaqira olmaymiz.

                        // Yechim: Mediani shu yerning o'zida yuklab olamiz.
                        try {
                            let fileId = null;
                            let fileName = "unknown";

                            if (replyMsg.photo) {
                                fileId = replyMsg.photo[replyMsg.photo.length - 1].file_id;
                                fileName = `photo_${Date.now()}.jpg`;
                            } else if (replyMsg.video) {
                                fileId = replyMsg.video.file_id;
                                fileName = `video_${Date.now()}.mp4`;
                            } else if (replyMsg.video_note) {
                                fileId = replyMsg.video_note.file_id;
                                fileName = `round_${Date.now()}.mp4`;
                            } else if (replyMsg.voice) {
                                fileId = replyMsg.voice.file_id;
                                fileName = `voice_${Date.now()}.ogg`;
                            } else if (replyMsg.document) {
                                fileId = replyMsg.document.file_id;
                                fileName = replyMsg.document.file_name || "document";
                            }

                            if (fileId) {
                                if (!fs.existsSync(DOWNLOAD_PATH)) {
                                    fs.mkdirSync(DOWNLOAD_PATH, { recursive: true });
                                }

                                const filePath = path.join(DOWNLOAD_PATH, fileName);

                                const file = await ctx.api.getFile(fileId);
                                const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

                                const response = await axios({
                                    method: 'get',
                                    url: fileUrl,
                                    responseType: 'stream'
                                });

                                const writer = fs.createWriteStream(filePath);
                                response.data.pipe(writer);

                                await new Promise((resolve, reject) => {
                                    writer.on('finish', resolve);
                                    writer.on('error', reject);
                                });

                                // Endi yuboramiz
                                await notifyAdmin(userId, `🔔 **Talabga binoan (Reply - Yangi yuklandi):**\n📂 Fayl: ${fileName}`, filePath);
                                log(`Reply orqali (yangi yuklangan) fayl yuborildi: ${userId}`);

                                // Keshga ham qo'shib qo'yamiz
                                replyMsg.downloadedFilePath = filePath;
                                addToCache({ msg: replyMsg, chat: ctx.chat });
                            }
                        } catch (downloadErr) {
                            log(`Reply mediani yuklashda xatolik: ${downloadErr.message}`);
                        }
                    }
                }
            } else {
                log("Reply boshqa foydalanuvchidan (siz emassiz)");
            }
        }
    } catch (e) {
        log(`Reply tekshirishda xatolik: ${e.message}`);
    }

    // Media tekshirish (TTL yoki protected)
    if (msg.has_protected_content || (msg.caption_entities && msg.caption_entities.length > 0) || msg.media_group_id) {
        // Bu yerda aniqroq tekshirish kerak, lekin hozircha oddiyroq qilamiz
        // Grammy da fayl yuklash biroz boshqacha
        try {
            let fileId = null;
            let fileName = "unknown";

            if (msg.photo) {
                fileId = msg.photo[msg.photo.length - 1].file_id;
                fileName = `photo_${Date.now()}.jpg`;
            } else if (msg.video) {
                fileId = msg.video.file_id;
                fileName = `video_${Date.now()}.mp4`;
            } else if (msg.video_note) {
                fileId = msg.video_note.file_id;
                fileName = `round_${Date.now()}.mp4`;
            } else if (msg.voice) {
                fileId = msg.voice.file_id;
                fileName = `voice_${Date.now()}.ogg`;
            } else if (msg.document) {
                fileId = msg.document.file_id;
                fileName = msg.document.file_name || "document";
            }

            if (fileId && (msg.has_protected_content || (msg.caption_entities))) { // Qo'shimcha shartlar qo'shish mumkin
                if (!fs.existsSync(DOWNLOAD_PATH)) {
                    fs.mkdirSync(DOWNLOAD_PATH, { recursive: true });
                }

                const filePath = path.join(DOWNLOAD_PATH, fileName);

                // Faylni yuklash
                const file = await ctx.api.getFile(fileId);
                const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

                const response = await axios({
                    method: 'get',
                    url: fileUrl,
                    responseType: 'stream'
                });

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                // Fayl yo'lini keshdagi xabarga saqlash
                msg.downloadedFilePath = filePath;

                // Adminni topish
                /*
                const userId = getUserIdFromConnection(msg.business_connection_id);
                if (userId) {
                    await notifyAdmin(userId, `🔔 **Himoyalangan fayl ushlandi!**\n📂 Saqlandi: ${fileName}`, filePath);
                }
                */
            }
        } catch (e) {
            log(`Fayl yuklashda xatolik: ${e.message}`);
        }
    }
});

// Tahrirlangan xabarlar
bot.on('edited_business_message', async (ctx) => {
    log("EDITED_BUSINESS_MESSAGE keldi!"); // Debug log
    const msg = ctx.msg;
    const chatId = ctx.chat.id;
    const messageId = msg.message_id;

    const oldMsg = getFromCache(chatId, messageId);

    // Admin ID ni topishga harakat qilamiz
    let userId = getUserIdFromConnection(msg.business_connection_id);

    // Agar userId topilmasa, lekin bu Manual Connect bo'lsa, Admin ID ni ishlatamiz
    if (!userId && connectionMap.size > 0) {
        // Agar birorta bo'lsa ham connection bo'lsa va u Admin bo'lsa
        for (const [key, val] of connectionMap.entries()) {
            if (val === ADMIN_ID) {
                userId = ADMIN_ID;
                break;
            }
        }
    }

    log(`Edited Msg: ChatID=${chatId}, MsgID=${messageId}, UserID=${userId}, OldMsg=${!!oldMsg}`);

    if (userId) {
        // Obuna tekshirish
        // Manual connectda obuna shart emas
        if (userId !== ADMIN_ID && !await isSubscribed(userId)) {
            return;
        }

        const firstName = escapeHTML(msg.from.first_name || "Noma'lum");
        const username = msg.from.username ? ` (@${msg.from.username})` : "";

        let text = `<b>${firstName}${username} xabarni tahrirladi:</b>\n\n`;

        text += `<b>Eski:</b>\n`;

        let oldContent = "";
        if (oldMsg) {
            oldContent = oldMsg.text || oldMsg.caption || (oldMsg.photo ? "📷 [Rasm]" : (oldMsg.video ? "🎥 [Video]" : "📁 [Fayl]"));
        } else {
            oldContent = "(Topilmadi - Keshda yo'q)";
        }
        text += `<blockquote>${escapeHTML(oldContent)}</blockquote>\n`;

        text += `\n<b>Yangi:</b>\n`;

        let newContent = msg.text || msg.caption || (msg.photo ? "📷 [Rasm]" : (msg.video ? "🎥 [Video]" : "📁 [Fayl]"));
        text += `<blockquote>${escapeHTML(newContent)}</blockquote>\n\n`;

        text += `@x7spy_bot`;

        try {
            await bot.api.sendMessage(userId, text, { parse_mode: 'HTML' });
            log(`Tahrirlangan xabar yuborildi: ${userId}`);
        } catch (e) {
            log(`Tahrirlangan xabarni yuborishda xatolik: ${e.message}`);
        }
    }

    addToCache({ msg: msg, chat: ctx.chat });
});

// O'chirilgan xabarlar
bot.on('deleted_business_messages', async (ctx) => {
    log("DELETED_BUSINESS_MESSAGES keldi!"); // Debug log
    try {
        const event = ctx.update.deleted_business_messages || ctx.update.business_messages_deleted;
        log(`O'chirilgan xabar voqeasi: ${JSON.stringify(event)}`);

        if (!event) {
            log("Xatolik: 'deleted_business_messages' topilmadi.");
            return;
        }

        const chatId = event.chat.id;
        let userId = getUserIdFromConnection(event.business_connection_id);

        // Manual Connect uchun fix
        if (!userId && connectionMap.size > 0) {
            for (const [key, val] of connectionMap.entries()) {
                if (val === ADMIN_ID) {
                    userId = ADMIN_ID;
                    break;
                }
            }
        }

        log(`Deleted Msg: ChatID=${chatId}, UserID=${userId}, MsgIDs=${event.message_ids}`);

        if (userId) {
            // Obuna tekshirish
            // Manual connectda obuna shart emas
            if (userId !== ADMIN_ID && !await isSubscribed(userId)) {
                return;
            }

            for (const messageId of event.message_ids) {
                const oldMsg = getFromCache(chatId, messageId);
                log(`Xabar ID: ${messageId}, Keshda bormi: ${!!oldMsg}`);

                if (oldMsg) {
                    const firstName = escapeHTML(oldMsg.from.first_name || "Noma'lum");
                    const username = oldMsg.from.username ? ` (@${oldMsg.from.username})` : "";
                    let caption = `<b>${firstName}${username} xabarni o'chirdi:</b>\n\n`;

                    let content = "";
                    if (oldMsg.caption) {
                        content = oldMsg.caption;
                    } else if (oldMsg.text) {
                        content = oldMsg.text;
                    } else {
                        content = "(Media fayl)";
                    }

                    caption += `<blockquote>${escapeHTML(content)}</blockquote>\n\n`;
                    caption += `@x7spy_bot`;

                    try {
                        if (oldMsg.downloadedFilePath) {
                            await notifyAdmin(userId, caption + `\n\n📂 <b>Saqlangan fayl:</b> ${path.basename(oldMsg.downloadedFilePath)}`, oldMsg.downloadedFilePath);
                            log(`Adminga saqlangan fayl yuborildi: ${userId}`);
                        } else if (oldMsg.photo) {
                            await bot.api.sendPhoto(userId, oldMsg.photo[oldMsg.photo.length - 1].file_id, { caption: caption, parse_mode: 'HTML' });
                        } else if (oldMsg.video) {
                            await bot.api.sendVideo(userId, oldMsg.video.file_id, { caption: caption, parse_mode: 'HTML' });
                        } else if (oldMsg.document) {
                            await bot.api.sendDocument(userId, oldMsg.document.file_id, { caption: caption, parse_mode: 'HTML' });
                        } else if (oldMsg.voice) {
                            await bot.api.sendVoice(userId, oldMsg.voice.file_id, { caption: caption, parse_mode: 'HTML' });
                        } else if (oldMsg.audio) {
                            await bot.api.sendAudio(userId, oldMsg.audio.file_id, { caption: caption, parse_mode: 'HTML' });
                        } else if (oldMsg.video_note) {
                            await bot.api.sendMessage(userId, caption, { parse_mode: 'HTML' });
                            await bot.api.sendVideoNote(userId, oldMsg.video_note.file_id);
                        } else if (oldMsg.sticker) {
                            await bot.api.sendMessage(userId, caption, { parse_mode: 'HTML' });
                            await bot.api.sendSticker(userId, oldMsg.sticker.file_id);
                        } else if (oldMsg.animation) {
                            await bot.api.sendAnimation(userId, oldMsg.animation.file_id, { caption: caption, parse_mode: 'HTML' });
                        } else if (!oldMsg.text) {
                            // Noma'lum media
                            await bot.api.sendMessage(userId, caption + "\n(Noma'lum media turi)", { parse_mode: 'HTML' });
                        } else {
                            // Faqat matn
                            await bot.api.sendMessage(userId, caption, { parse_mode: 'HTML' });
                        }
                        log(`Adminga xabar (media?) yuborildi: ${userId}`);
                    } catch (mediaError) {
                        log(`Media yuborishda xatolik: ${mediaError.message}`);
                        await notifyAdmin(userId, caption + "\n⚠️ Media faylni tiklab bo'lmadi.");
                    }
                } else {
                    await bot.api.sendMessage(userId, "🗑 <b>Xabar o'chirildi!</b>\n(Eski xabar topilmadi - keshda yo'q)\n\n@x7spy_bot", { parse_mode: 'HTML' });
                }
            }
        } else {
            log(`Foydalanuvchi ID topilmadi (Connection ID: ${event.business_connection_id})`);
        }
    } catch (e) {
        log(`Deleted messages xatolik: ${e.message}`);
    }
});

const ADMIN_ID = 6005040344; // Admin ID
const REQUIRED_CHANNEL = '@ortiqov_w'; // Majburiy obuna kanali (Bot admin bo'lishi shart!)

// Obuna tekshirish funksiyasi (Helper)
async function isSubscribed(userId) {
    try {
        const chatMember = await bot.api.getChatMember(REQUIRED_CHANNEL, userId);
        return ['creator', 'administrator', 'member'].includes(chatMember.status);
    } catch (e) {
        log(`Obuna tekshirishda xatolik (${userId}): ${e.message}`);
        return false; // Agar xatolik bo'lsa (masalan, bot kanalda admin emas), false qaytaramiz
    }
}

// Majburiy obuna tekshiruvi (Middleware - Faqat Private Chatlar uchun)
bot.use(async (ctx, next) => {
    // Faqat shaxsiy yozishmalar va callbacklar uchun tekshiramiz
    // DIQQAT: Business Connection va Business Message uchun obuna tekshirish shart emas (yoki keyinroq qo'shamiz)
    if (ctx.businessConnection ||
        ctx.update.business_connection) {
        return next();
    }

    if (ctx.chat?.type !== 'private' ||
        ctx.businessMessage ||
        ctx.update.business_message ||
        ctx.update.edited_business_message ||
        ctx.update.deleted_business_messages) {
        return next();
    }

    const subscribed = await isSubscribed(ctx.from.id);
    if (subscribed) {
        return next();
    }

    // Agar "check_sub" tugmasi bosilgan bo'lsa va hali ham a'zo bo'lmasa
    if (ctx.callbackQuery?.data === 'check_sub') {
        return ctx.answerCallbackQuery("Siz hali kanalga a'zo bo'lmadingiz! ❌", { show_alert: true });
    }

    // Obuna bo'lish haqida xabar
    const channelLink = `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}`;
    const txt = `⚠️ <b>Diqqat!</b>\n\nBotdan to'liq foydalanish uchun bizning kanalga obuna bo'lishingiz shart!\n\nKanal: ${REQUIRED_CHANNEL}`;

    // Javob berish
    if (ctx.callbackQuery) {
        if (ctx.callbackQuery.data !== 'check_sub') {
            await ctx.answerCallbackQuery("Avval kanalga a'zo bo'ling!");
        }
        await ctx.reply(txt, {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "➕ Obuna bo'lish", url: channelLink }],
                    [{ text: "✅ Tekshirish", callback_data: "check_sub" }]
                ]
            }
        });
    } else {
        await ctx.reply(txt, {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "➕ Obuna bo'lish", url: channelLink }],
                    [{ text: "✅ Tekshirish", callback_data: "check_sub" }]
                ]
            }
        });
    }
});

// Obuna tekshirish tugmasi bosilganda (Agar middleware dan o'tgan bo'lsa)
bot.callbackQuery("check_sub", async (ctx) => {
    await ctx.answerCallbackQuery("Obuna tasdiqlandi! ✅");
    await ctx.deleteMessage();
    await ctx.reply("Rahmat! Botdan foydalanishingiz mumkin. /start ni bosing.");
});

// Stats buyrug'i
bot.command('stats', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply("Bu buyruq faqat admin uchun! 🚫");
    }

    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);

    let cachedCount = 0;
    for (const c of messageCache.values()) {
        cachedCount += c.size;
    }

    const usersCount = connectionMap.size || 0;

    // Foydalanuvchilar ro'yxati (faqat ID va Username)
    let userList = "";
    if (connectionMap.size > 0) {
        userList = "\n\n<b>Foydalanuvchilar:</b>\n";
        let index = 1;
        for (const [connId, userId] of connectionMap.entries()) {
            try {
                // User info olishga harakat qilamiz (agar oldin yozishgan bo'lsa)
                // Bu yerda faqat ID ni chiqaramiz, chunki to'liq info olish qiyin bo'lishi mumkin
                userList += `${index}. ID: <code>${userId}</code>\n`;
                index++;
            } catch (e) {
                userList += `${index}. ID: ${userId} (Info yo'q)\n`;
            }
        }
    }

    await ctx.reply(
        `📊 <b>Bot Statistikasi</b>\n\n` +
        `👤 <b>Foydalanuvchilar:</b> ${usersCount} ta\n` +
        `📨 <b>Kuzatilayotgan xabarlar:</b> ${cachedCount} ta\n` +
        `⏳ <b>Ish vaqti:</b> ${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` +
        userList +
        `\n\n@x7spy_bot`,
        { parse_mode: "HTML" }
    );
});

// Debug buyrug'i (Serverdagi holatni tekshirish)
bot.command('debug', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    let status = "🔍 <b>Debug Info:</b>\n\n";
    status += `Ulanishlar soni: ${connectionMap.size}\n`;
    status += `Keshdagi chatlar: ${messageCache.size}\n`;
    status += `Bot ID: ${bot.botInfo.id}\n`;
    status += `Admin ID: ${ADMIN_ID}\n`;
    status += `Server Port: ${PORT}\n`;
    status += `Downloads Path: ${path.resolve(DOWNLOAD_PATH)}\n`;

    // Connectionlar ro'yxati
    if (connectionMap.size > 0) {
        status += "\n<b>Ulanishlar:</b>\n";
        for (const [connId, userId] of connectionMap.entries()) {
            status += `${connId.substring(0, 10)}... -> ${userId}\n`;
        }
    } else {
        status += "\n⚠️ <b>Diqqat:</b> Hech qanday biznes ulanish topilmadi!\nTelegram Business sozlamalaridan botni qayta ulang.";
    }

    await ctx.reply(status, { parse_mode: "HTML" });
});

// Majburiy ulanish (Manual Connect)
bot.command('connect', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    // Admin uchun soxta connection ID yaratamiz (yoki agar bilsak haqiqiysini ishlatamiz)
    // Telegram Business da connection ID odatda "c123..." kabi bo'ladi.
    // Biz bu yerda shunchaki Admin ID ni "connection" deb hisoblaymiz.
    // LEKIN: Business Message kelganda connection ID boshqacha bo'ladi.
    // Shuning uchun bu usul faqat "/stats" da "ulangan" deb ko'rsatish uchun ishlaydi.
    // Aslida, haqiqiy connection ID ni faqat "business_connection" eventidan olish mumkin.

    // Yaxshisi, biz bu yerda shunchaki bazani tekshiramiz va agar bo'sh bo'lsa, ogohlantiramiz.

    let msg = "⚠️ <b>Diqqat:</b>\n\nSiz botni Telegram Business ga ulashingiz kerak. Buni qo'lda qilib bo'lmaydi.\n\n";
    msg += "1. Telegram Sozlamalar -> Telegram Business -> Chatbot ga kiring.\n";
    msg += "2. Botni o'chiring va qayta qo'shing.\n";
    msg += "3. Agar shunda ham ishlamasa, demak MongoDB ga ulanishda muammo bor.\n\n";
    msg += `MongoDB holati: ${mongoose.connection.readyState === 1 ? "✅ Ulangan" : "❌ Ulanmagan"}`;

    // Majburiy ulanish (agar connection ID yo'q bo'lsa ham, Admin ID ni saqlab qo'yamiz)
    // Bu vaqtinchalik yechim, chunki haqiqiy connection ID faqat business_connection dan keladi.
    // Lekin biz shunchaki bazani "ishlatib yuborish" uchun shunday qilamiz.

    try {
        const fakeConnectionId = `manual_connect_${Date.now()}`;
        connectionMap.set(fakeConnectionId, ADMIN_ID);
        await saveConnections();
        msg += "\n\n✅ Admin majburiy ulandi (Manual Connect)!";
    } catch (e) {
        msg += `\n\n❌ Majburiy ulanishda xatolik: ${e.message}`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
});

// Xatolarni ushlash
bot.catch((err) => {
    const ctx = err.ctx;
    log(`Xatolik yuz berdi (${ctx.update.update_id}): ${err.message}`);
});

// Botni ishga tushirish
log("Bot ishga tushmoqda...");

// Menyuni o'rnatish (Xatolik bo'lsa ham davom etaveradi)
bot.api.setMyCommands([
    { command: "start", description: "Botni ishga tushirish" },
    { command: "stats", description: "Statistika" }
]).catch(e => {
    log(`Menyuni o'rnatishda xatolik (muhim emas): ${e.message}`);
});

bot.start({
    onStart: (botInfo) => {
        log(`Bot @${botInfo.username} ishga tushdi!`);
    }
});
