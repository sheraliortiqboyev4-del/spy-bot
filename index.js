require('dotenv').config();
const { Bot, InputFile } = require('grammy');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http'); // Render uchun server kerak

// Konfiguratsiya
const BOT_TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH || './downloads/';
const CONNECTION_FILE = 'connections.json';
const MAX_CACHE_SIZE = 500;
const PORT = process.env.PORT || 3000; // Render portni o'zi beradi

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
function loadConnections() {
    if (fs.existsSync(CONNECTION_FILE)) {
        try {
            const data = fs.readFileSync(CONNECTION_FILE, 'utf8');
            const json = JSON.parse(data);
            connectionMap = new Map(Object.entries(json));
            log(`Yuklangan ulanishlar: ${connectionMap.size}`);
        } catch (e) {
            log(`Ulanishlarni yuklashda xatolik: ${e.message}`);
        }
    }
}

// Ulanishlarni saqlash
function saveConnections() {
    try {
        const obj = Object.fromEntries(connectionMap);
        fs.writeFileSync(CONNECTION_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        log(`Ulanishlarni saqlashda xatolik: ${e.message}`);
    }
}

loadConnections();

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

// Start buyrug'i
bot.command('start', async (ctx) => {
    const user = ctx.from;
    const userName = escapeHTML(user.first_name);
    
    // Rasm URL (Siz xohlagan rasmga o'zgartirishingiz mumkin)
    // Telegram logotipi
    const photoUrl = "AgACAgIAAxkBAAM4aZyac4hPwl6nHjPTbHoNh9PMelYAAjERaxvvFelIfubzN0vEdxIBAAMCAAN5AAM6BA"; 

    const caption = `<b>Xush kelibsiz!</b>\n` +
                    `👨‍✈️ <b>Bu bot yozishmalaringizda sizga yordamchi bo'ladi.</b>\n\n` +
                    `<i>Bot imkoniyatlari:</i>\n` +
                    `• Suhbatdoshingiz xabarni o'zgartirsa yoki o'chirsa, darhol sizga bildirishnoma yuboradi 🔔\n` +
                    `• Taymerli (bir martalik) fayllarni yuklab oladi va saqlab qoladi: rasm, video, ovozli xabarlar va dumaloq videolar ⏳\n\n` +
                    `<blockquote>❓ Botni qanday ulash kerakligi — yuqoridagi rasmda ko'rsatilgan 👆</blockquote>`;

    await ctx.replyWithPhoto(photoUrl, {
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "▶️ Bot ishlashini ko'rish", callback_data: "demo" }
                ]
            ]
        }
    });
});

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
    saveConnections();
    
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
            connectionMap.set(msg.business_connection_id, userId);
            saveConnections();
        } catch (e) {}
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
    const msg = ctx.msg;
    const chatId = ctx.chat.id;
    const messageId = msg.message_id;
    
    const oldMsg = getFromCache(chatId, messageId);
    const userId = getUserIdFromConnection(msg.business_connection_id);
    
    if (userId) {
        // Obuna tekshirish
        if (!await isSubscribed(userId)) {
            // Agar obuna bo'lmasa, hech narsa qilmaymiz (yoki ogohlantirish yuboramiz)
            // Hozircha shunchaki return qilamiz
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
    try {
        const event = ctx.update.deleted_business_messages || ctx.update.business_messages_deleted;
        log(`O'chirilgan xabar voqeasi: ${JSON.stringify(event)}`);
        
        if (!event) {
            log("Xatolik: 'deleted_business_messages' topilmadi.");
            return;
        }

        const chatId = event.chat.id;
        const userId = getUserIdFromConnection(event.business_connection_id);
        
        log(`Chat ID: ${chatId}, User ID: ${userId}, Message IDs: ${event.message_ids}`);
        
        if (userId) {
            // Obuna tekshirish
            if (!await isSubscribed(userId)) {
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
    if (ctx.chat?.type !== 'private' || 
        ctx.businessConnection || 
        ctx.businessMessage || 
        ctx.update.business_connection || 
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

// Xatolarni ushlash
bot.catch((err) => {
    const ctx = err.ctx;
    log(`Xatolik yuz berdi (${ctx.update.update_id}): ${err.message}`);
});

// Botni ishga tushirish
log("Bot ishga tushmoqda...");

// Menyuni o'rnatish
bot.api.setMyCommands([
    { command: "start", description: "Botni ishga tushirish" },
    { command: "stats", description: "Statistika" }
]);

bot.start({
    onStart: (botInfo) => {
        log(`Bot @${botInfo.username} ishga tushdi!`);
    }
});
