import os
import asyncio
import logging
import json
import sys
import time

# Debug print
print("Dastur boshlanmoqda...", flush=True)

from aiogram import Bot, Dispatcher, F, types
from aiogram.enums import ContentType
from aiogram.filters import CommandStart, Command
from aiogram.exceptions import TelegramConflictError
from dotenv import load_dotenv

# .env faylini yuklash
load_dotenv()

BOT_TOKEN = os.getenv('BOT_TOKEN')
DOWNLOAD_PATH = os.getenv('DOWNLOAD_PATH', './downloads/')
CONNECTION_FILE = 'connections.json'

print(f"Token yuklandi: {BOT_TOKEN[:10]}..." if BOT_TOKEN else "Token yo'q!", flush=True)

if not BOT_TOKEN or BOT_TOKEN == "SIZNING_BOT_TOKENINGIZ":
    print("XATOLIK: .env faylida BOT_TOKEN to'ldirilmagan!", flush=True)
    sys.exit(1)

# Loggingni yoqish (Faylga va Konsolga)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("bot.log"),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Bot va Dispatcher yaratish
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# Xabarlar keshi (RAM da)
message_cache = {}
MAX_CACHE_SIZE = 500

# Connection mapping (RAM + File)
connection_map = {}

def load_connections():
    """Fayldan ulanishlarni yuklash"""
    global connection_map
    if os.path.exists(CONNECTION_FILE):
        try:
            with open(CONNECTION_FILE, 'r') as f:
                connection_map = json.load(f)
            logger.info(f"Yuklangan ulanishlar: {len(connection_map)}")
        except Exception as e:
            logger.error(f"Ulanishlarni yuklashda xatolik: {e}")

def save_connections():
    """Ulanishlarni faylga saqlash"""
    try:
        with open(CONNECTION_FILE, 'w') as f:
            json.dump(connection_map, f)
    except Exception as e:
        logger.error(f"Ulanishlarni saqlashda xatolik: {e}")

# Dastur boshida yuklab olamiz
load_connections()

def add_to_cache(message: types.Message):
    """Xabarni keshga qo'shish"""
    chat_id = message.chat.id
    if chat_id not in message_cache:
        message_cache[chat_id] = {}
    
    # Kesh hajmini tekshirish
    if len(message_cache[chat_id]) >= MAX_CACHE_SIZE:
        # Eng eski xabarni o'chirish
        min_id = min(message_cache[chat_id].keys())
        del message_cache[chat_id][min_id]
        
    message_cache[chat_id][message.message_id] = message

def get_from_cache(chat_id, message_id):
    """Keshdan xabarni olish"""
    return message_cache.get(chat_id, {}).get(message_id)

async def notify_admin(user_id, text, file_path=None):
    """Admin (biznes egasi) ga xabar yuborish"""
    try:
        if file_path:
            file = types.FSInputFile(file_path)
            await bot.send_document(user_id, document=file, caption=text)
        else:
            await bot.send_message(user_id, text)
    except Exception as e:
        logger.error(f"Adminga ({user_id}) xabar yuborishda xatolik: {e}")

@dp.message(CommandStart())
async def command_start_handler(message: types.Message):
    """Botga /start bosilganda ishlaydi"""
    await message.answer(
        f"Salom, {message.from_user.full_name}! Bot ishga tushdi.\n\n"
        "1. Telegram Business sozlamalarida botni ulang.\n"
        "2. Keyin bot avtomatik ravishda xabarlarni kuzatib boradi.\n"
        "Statusni tekshirish uchun /status yozing."
    )

@dp.message(Command("status"))
async def command_status_handler(message: types.Message):
    """Bot statusini tekshirish"""
    count = 0
    # User ID bo'yicha connection borligini tekshirish
    user_id_str = str(message.from_user.id)
    
    # Connection map dagi qiymatlarni tekshiramiz (user_id -> connection_id emas, connection_id -> user_id saqlayapmiz)
    # Lekin biz user_id ni bilamiz, demak connection borligini tekshirishimiz mumkin
    is_connected = False
    for conn_id, uid in connection_map.items():
        if str(uid) == user_id_str:
            is_connected = True
            break
            
    status_text = "✅ Bot ishlayapti.\n"
    if is_connected:
        status_text += "🔗 Sizning biznes akkauntingiz ulangan."
    else:
        status_text += "⚠️ Sizning biznes akkauntingiz hali ulanmagan yoki bot qayta ishga tushganidan beri yangilanmagan."
        
    await message.answer(status_text)

@dp.business_connection()
async def on_business_connection(connection: types.BusinessConnection):
    """Foydalanuvchi botni biznes akkauntiga ulaganda"""
    logger.info(f"Yangi Business connection: {connection.id} -> User: {connection.user.id}")
    
    connection_map[connection.id] = connection.user.id
    save_connections()
    
    try:
        await bot.send_message(connection.user.id, "✅ Bot muvaffaqiyatli ulandi! Endi men xabarlarni kuzatib boraman.")
    except Exception as e:
        logger.error(f"Xabar yuborishda xatolik: {e}")

def get_user_id_from_connection(connection_id):
    """Connection ID orqali User ID ni topish"""
    if connection_id in connection_map:
        return connection_map[connection_id]
    
    # Fallback: agar map da yo'q bo'lsa, ID dan ajratib olishga harakat qilamiz
    try:
        return int(connection_id.split(':')[0])
    except:
        return None

@dp.business_message()
async def handle_business_message(message: types.Message):
    """Yangi biznes xabarlari"""
    # Xabarni keshga saqlash
    add_to_cache(message)
    
    # Connection ID ni saqlab qo'yamiz agar yangi bo'lsa
    if message.business_connection_id and message.business_connection_id not in connection_map:
        # Bu yerda user_id ni aniqlash qiyin, chunki message.from_user har doim ham biznes egasi emas.
        # Lekin message.chat.id agar private bo'lsa va message.from_user.id != message.chat.id bo'lsa...
        # Yaxshisi, connection event ni kutamiz yoki split qilamiz.
        try:
            user_id = int(message.business_connection_id.split(':')[0])
            connection_map[message.business_connection_id] = user_id
            save_connections()
        except:
            pass

    # Taymerli (TTL) yoki o'chib ketadigan mediani tekshirish
    if message.media and (message.has_protected_content or message.caption_entities):
        try:
            # Fayl ID sini aniqlash
            file_id = None
            file_name = "unknown"
            
            if message.photo:
                file_id = message.photo[-1].file_id
                file_name = f"photo_{message.date.strftime('%Y%m%d_%H%M%S')}.jpg"
            elif message.video:
                file_id = message.video.file_id
                file_name = f"video_{message.date.strftime('%Y%m%d_%H%M%S')}.mp4"
            elif message.video_note:
                file_id = message.video_note.file_id
                file_name = f"round_{message.date.strftime('%Y%m%d_%H%M%S')}.mp4"
            elif message.voice:
                file_id = message.voice.file_id
                file_name = f"voice_{message.date.strftime('%Y%m%d_%H%M%S')}.ogg"
            elif message.document:
                file_id = message.document.file_id
                file_name = message.document.file_name or "document"
            
            if file_id:
                # Papkani yaratish
                if not os.path.exists(DOWNLOAD_PATH):
                    os.makedirs(DOWNLOAD_PATH)
                
                file_path = os.path.join(DOWNLOAD_PATH, file_name)
                
                # Yuklab olish
                file = await bot.get_file(file_id)
                await bot.download_file(file.file_path, file_path)
                
                # Adminni topish
                user_id = get_user_id_from_connection(message.business_connection_id)
                
                if user_id:
                     await notify_admin(
                        user_id,
                        f"🔔 **Himoyalangan fayl ushlandi!**\n📂 Saqlandi: {file_name}",
                        file_path
                    )
        except Exception as e:
            logger.error(f"Fayl yuklashda xatolik: {e}")

@dp.edited_business_message()
async def handle_edited_business_message(message: types.Message):
    """Tahrirlangan biznes xabarlari"""
    chat_id = message.chat.id
    message_id = message.message_id
    old_message = get_from_cache(chat_id, message_id)
    
    user_id = get_user_id_from_connection(message.business_connection_id)
    if not user_id:
        return

    text = f"✏️ **Xabar tahrirlandi!**\n"
    text += f"👤 Suhbatdosh: {message.from_user.full_name}\n"
    
    if old_message:
        text += f"📝 **Eski:** {old_message.text or 'Media'}\n"
    else:
        text += "📝 **Eski:** (Topilmadi - Bot ishga tushishidan oldin yozilgan)\n"
        
    text += f"🆕 **Yangi:** {message.text or 'Media'}"
    
    await notify_admin(user_id, text)
    
    # Keshni yangilash
    add_to_cache(message)

@dp.deleted_business_messages()
async def handle_deleted_business_messages(event: types.BusinessMessagesDeleted):
    """O'chirilgan biznes xabarlari"""
    chat_id = event.chat.id
    
    user_id = get_user_id_from_connection(event.business_connection_id)
    if not user_id:
        return

    for message_id in event.message_ids:
        old_message = get_from_cache(chat_id, message_id)
        
        if old_message:
            text = f"🗑 **Xabar o'chirildi!**\n"
            text += f"👤 Suhbatdosh: {old_message.from_user.full_name}\n"
            text += f"📝 **Mazmuni:** {old_message.text or 'Media fayl'}"
            
            await notify_admin(user_id, text)
        else:
            # Agar keshda bo'lmasa, shunchaki xabar berish (ixtiyoriy)
             pass

async def main():
    print("Bot ishga tushmoqda...", flush=True)
    # Avvalgi webhooklarni tozalash (agar bo'lsa)
    await bot.delete_webhook(drop_pending_updates=True)
    
    while True:
        try:
            print("Polling boshlanmoqda...", flush=True)
            await dp.start_polling(bot)
        except TelegramConflictError:
            print("XATOLIK: Boshqa bot instansiyasi ishlayapti! (Conflict)", flush=True)
            logger.error("Conflict error. Retrying in 5 seconds...")
            await asyncio.sleep(5)
        except Exception as e:
            print(f"Xatolik yuz berdi: {e}", flush=True)
            logger.error(f"Polling error: {e}")
            await asyncio.sleep(5)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Bot to'xtatildi.", flush=True)
    except Exception as e:
        print(f"Kritik xatolik: {e}", flush=True)
