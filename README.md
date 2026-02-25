# Telegram UserBot (Dialog Bot)

Bu bot sizning Telegram akkauntingizda ishlaydi va quyidagi vazifalarni bajaradi:
1.  **O'chirilgan xabarlarni aniqlash**: Agar suhbatdoshingiz xabarni o'chirsa, bot uni "Saved Messages" (Saqlangan xabarlar) ga yuboradi.
2.  **Tahrirlangan xabarlarni aniqlash**: Xabar o'zgartirilganda eski va yangi versiyasini ko'rsatadi.
3.  **Taymerli fayllarni yuklab olish**: O'zini o'zi yo'q qiladigan (taymerli) rasmlar, videolar va ovozli xabarlarni avtomatik yuklab oladi va `downloads` papkasiga saqlaydi.

## O'rnatish

1.  Ushbu papkada `.env` faylini oching.
2.  `API_ID` va `API_HASH` ma'lumotlarini kiriting.
    *   Bu ma'lumotlarni olish uchun: https://my.telegram.org saytiga kiring.
    *   Telefon raqamingiz bilan kiring.
    *   "API development tools" bo'limiga o'ting.
    *   Yangi ilova yarating (nomi ixtiyoriy).
    *   `App api_id` va `App api_hash` ni nusxalab oling.
3.  `.env` fayliga yozing:
    ```
    API_ID=12345678
    API_HASH=sizning_uzun_hash_kodingiz
    ```

## Ishga tushirish

Botni ishga tushirish uchun terminalda quyidagi buyruqni yozing:

```bash
python main.py
```

Birinchi marta ishga tushirganda, Telegram telefon raqamingizni va kelgan kodni kiritishingiz so'raladi. Keyin bot fon rejimida ishlaydi.

## Fayllar
Yuklab olingan fayllar `downloads` papkasida paydo bo'ladi.
Bildirishnomalar sizning "Saved Messages" (Saqlangan xabarlar) chatida ko'rinadi.
