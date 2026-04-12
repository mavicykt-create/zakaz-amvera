diff --git a/README.md b/README.md
index 162d765af1b9586dd086186927b0e681bf58406a..cd1a901edda10e22718ab06af28af94bcdd00b00 100644
--- a/README.md
+++ b/README.md
@@ -1,55 +1,62 @@
Amvera Mobile Order
Готовый проект под Amvera:
мобильная витрина товаров из YML
фильтрация по категории `CATEGORY_ID`
показ срока годности из `<param name="Срок годности">`
прокси и сжатие изображений через `sharp`
кнопка актуализации
отправка заказов
простая админка с паролем
1. Переменные окружения
-Скопируй `.env.example` в `.env` и задай значения.
+Скопируй `.env.example` в `.env` и при необходимости измени значения:
+
+- `PORT` — порт сервера
+- `ADMIN_PASSWORD` — пароль для админ-маршрутов
+- `IMAGE_WIDTH`, `IMAGE_QUALITY` — параметры оптимизации изображений
+- `CACHE_TTL_MS` — TTL кеша
2. Локальный запуск
```bash
 npm install
 npm run dev
 ```
3. Маршруты
`/` — мобильная витрина
`/admin` — админка заказов
+- `/upload-commerceml` — страница загрузки CommerceML ZIP
+- `/api/health` — статус каталога и свежесть кеша
`/api/products` — список товаров
-- `/api/refresh` — обновить каталог
-- `/api/orders` — создать заказ
-- `/api/orders?password=...` — список заказов
+- `/api/commerceml/upload-zip` (`POST`, `multipart/form-data`) — загрузить CommerceML архив (требует пароль администратора)
+- `/api/orders` (`POST`) — создать заказ
+- `/api/orders?password=...` (`GET`) — список заказов
`/img?url=...` — сжатая картинка
4. Логика данных
Проект ожидает стандартный YML:
категории в `<categories>`
товары в `<offers>`
категория товара в `<categoryId>`
срок годности в `<param name="Срок годности">...`
Если срок годности в фиде лежит в другом поле, поправь функцию `extractShelfLife`.
5. Деплой в Amvera
Нужен обычный Node.js app:
start command: `npm start`
порт берётся из `PORT`
статические файлы уже раздаются Express-ом
6. Что можно быстро доработать
поиск по артикулу
фильтр по сроку годности
отправка заказа в ваш backend / 1С API
авторизация сотрудников
