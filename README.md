# Загас тэмдэглэл (Drive)

Дата нь таны **Google Drive** дээрх CSV файлуудад хадгалагддаг загасчлалын тэмдэглэлийн PWA. Утас, компьютер аль алинаас нь ижил датаг харж, нэмж болно. Сервер шаардлагагүй: апп браузераас Drive API руу шууд хандана.

## Функцүүд

1. **Аялал**: эхэлсэн, дууссан огноо, гол/байршил, хамт явсан хүмүүс, тэмдэглэл
2. **Барьсан загас**: огноо, цаг, төрөл, урт, жин, өгөөш, өнгө, зураг, тэмдэглэл
3. **Усны нөхцөл**: тунгалаг, булингартай, их ус, бага ус, хар уснаас, жижиг харгианаас, цүнхээлээс
4. **Статистик**: аялал, барьсан загас, хамгийн урт, топ өгөөш
5. **Хайлт**: газар, хүн, загас, өгөөш, тэмдэглэлээр (олон үгээр хайж болно, жишээ нь `Тул Jig`)
6. **Офлайн**: апп сүлжээгүй үед ч нээгдэнэ. Хийсэн өөрчлөлт дараалалд хадгалагдаж, сүлжээ орохоор Drive руу автоматаар илгээгдэнэ.

## Drive дээрх бүтэц

```
My Drive/
└── fishing-app/
    ├── trips.csv      ← нэг аялал нэг мөр
    ├── catches.csv    ← нэг загас нэг мөр (trip_id-аар аялалтай холбогдоно)
    └── photos/        ← апп автоматаар үүсгэнэ
```

`catches.csv`-ийн `photos` баганад Drive дээрх зургийн ID-ууд `|` тэмдгээр тусгаарлагдан бичигдэнэ. CSV-г Google Sheets эсвэл Excel дээр нээж харж болно. Гараар засах бол багануудын нэрийг өөрчилж болохгүй.

---

## Тохируулах (нэг удаа)

### 1. CSV-г Drive руу хуулах

1. Drive-ийн **Settings → General → Convert uploads** тохиргоо **унтраалттай** байгаа эсэхийг шалгана. Асаалттай бол CSV нь Google Sheet болж хувирч, апп уншиж чадахгүй.
2. My Drive дотор `fishing-app` нэртэй хавтас үүсгэнэ.
3. `export/trips.csv`, `export/catches.csv` файлуудыг тэр хавтас руу upload хийнэ.

### 2. Google Cloud дээр OAuth Client ID үүсгэх

1. https://console.cloud.google.com руу орж шинэ project үүсгэнэ (жишээ нь `fishing-app`).
2. **APIs & Services → Library** хэсгээс **Google Drive API**-г хайж **Enable** дарна.
3. **APIs & Services → OAuth consent screen** (эсвэл **Google Auth Platform → Branding**):
   - User type: **External**
   - App name: `Загас тэмдэглэл`, support email: өөрийн email
   - **Audience → Test users** хэсэгт өөрийн Gmail хаягийг нэмнэ.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins**:
     - `https://tgesevo.github.io`
     - `http://localhost:8080` (компьютер дээр туршихад)
   - Redirect URI хэрэггүй.
5. Гарч ирсэн **Client ID**-г (`....apps.googleusercontent.com`) хуулж авна.

Client ID-г `config.js` доторх `clientId` талбарт бичнэ. Эсвэл хоосон үлдээвэл апп анх нээгдэхэд асууна.

> Апп "Testing" төлөвтэй тул анх нэвтрэхэд Google "Google hasn't verified this app" гэж анхааруулна. **Continue** дарж үргэлжлүүлнэ. Энэ бол таны өөрийн апп тул аюулгүй.

### 3. GitHub Pages дээр байрлуулах

```bash
cd ~/Develop/fishing-app/drive-app
git init && git add . && git commit -m "Drive-backed fishing log"
gh repo create fishing-drive-pwa --public --source=. --push
gh api -X POST repos/tgesevo/fishing-drive-pwa/pages -f "source[branch]=main" -f "source[path]=/"
```

Хэдэн минутын дараа апп https://tgesevo.github.io/fishing-drive-pwa/ хаягаар нээгдэнэ.

Репо public байсан ч таны дата ил гарахгүй: дата зөвхөн таны Drive дээр байх бөгөөд таны Google нэвтрэлтээр л уншигдана. Client ID нь нууц мэдээлэл биш.

### 4. Утсан дээр суулгах

Android Chrome дээр линкийг нээгээд **⋮ → Add to Home screen / Install app** дарна. Дараа нь **Google-ээр нэвтрэх** дарна.

---

## Компьютер дээр туршиж ажиллуулах

```bash
cd ~/Develop/fishing-app/drive-app
python3 -m http.server 8080
# http://localhost:8080 нээнэ
```

Drive-гүйгээр туршихдаа `mock/` хавтсанд `trips.csv`, `catches.csv`-г хийгээд `http://localhost:8080/?mock=1&autologin=1` хаягаар нээнэ. Энэ горимд дата браузерын localStorage-д хадгалагдана.

## Анхаарах зүйл

- Google-ийн нэвтрэлт 1 цагийн дараа дуусдаг. Дуусахад дээд талын товч дээр **Нэвтрэх** гэж гарна, нэг дарахад л сэргэнэ. Энэ хооронд хийсэн өөрчлөлт утсан дээр хадгалагдсан хэвээр байна.
- Хоёр төхөөрөмжөөс нэгэн зэрэг засахад sync бүр Drive-аас хамгийн сүүлийн хувилбарыг уншиж, өөрийн өөрчлөлтийг түүн дээр нэмж бичдэг. Тиймээс бусад мөрүүд дарагдахгүй. Харин яг нэг мөрийг хоёр газраас засвал хамгийн сүүлд хадгалсан нь үлдэнэ.
- Зургийг upload хийхээс өмнө 1600px хүртэл багасгаж, JPEG болгоно.
- Аялал эсвэл загас устгахад холбогдох зургууд Drive-ийн **Trash** руу орно. 30 хоногийн дотор сэргээж болно.

## Файлын бүтэц

- `index.html`, `src/styles.css`: дэлгэц
- `src/app.js`: дэлгэцүүд, офлайн дараалал, sync
- `src/model.js`: CSV ↔ аялал/загас хөрвүүлэлт
- `src/csv.js`: CSV parser (олон мөрт тэмдэглэл, хашилт, BOM)
- `src/drive.js`: Google Drive API, туршилтын MockDrive
- `src/store.js`: IndexedDB (офлайн хуулбар, дараалал, зураг)
- `sw.js`: офлайн cache
- `config.js`: Client ID, хавтасны нэр
