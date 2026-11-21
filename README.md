# ikas Abonelik (Düzenli Teslimat) Modülü

Kart saklamadan çalışan abonelik sistemi. Müşteri ürün sayfasında "Düzenli Teslimat"ı ve bir periyot seçer,
sistem her teslimat gününde müşteri adına ikas'ta sipariş açar ve müşteriye mail atar.

## Nasıl çalışır
1. **Ürün sayfası** (`public/widget.js`): Aboneliğe açılmış ürünlerde "Sepete Ekle" butonunun üstüne
   *Tek Seferlik / Düzenli Teslimat (%indirim)* seçimi eklenir. Müşteri periyodu seçip formu doldurur
   (ad, e-posta, telefon, adres, ilk teslimat tarihi). Kart bilgisi alınmaz.
2. **Zamanlayıcı** (varsayılan 15 dk'da bir): `next_date` bugün veya geçmişte olan aktif aboneliklerde
   `createOrderWithTransactions` ile sipariş oluşturur, fiyatı ikas'tan güncel çeker, indirimi uygular,
   `next_date`'i periyot kadar ilerletir. Aynı tarih için ikinci sipariş açılmaz. Hata olursa 5 kez dener ve `ADMIN_EMAIL`'e haber verir.
3. **Mailler**: hoş geldin, teslimattan N gün önce hatırlatma, sipariş oluşturuldu, iptal.
   Maillerdeki link (`/s/<token>`) ile müşteri teslimatı atlayabilir, tarihini değiştirebilir, periyodunu değiştirebilir, duraklatabilir veya iptal edebilir.
4. **Satıcı paneli** (`/admin`, Basic Auth): periyotları ekle/düzenle (gün/hafta/ay), varsayılan ve ürün bazlı indirim,
   ürün bazlı izinli periyotlar, ödeme yöntemi/satış kanalı, abonelik/sipariş/mail listeleri, mağazaya script kurulumu.

## Kurulum
```bash
npm install
cp .env.example .env   # değerleri doldurun
npm start
```
- ikas panelinde **özel uygulama** (private app) oluşturun; ürün ve sipariş okuma/yazma izinleri verin, client id/secret'ı `.env`'e yazın.
- Sunucu internetten erişilebilir olmalı (`PUBLIC_URL`), çünkü mağaza `widget.js`'i oradan yükler.
- Panel > Ayarlar: "ikas'tan getir" → satış kanalı, **ödeme yöntemi** (kapıda ödeme / havale gibi) ve storefront seçin → kaydedin → "Mağazaya yükle".
- Panel > Ürünler: ürünleri "Aboneliğe aç", gerekirse indirim ve periyotları ürün bazında ayarlayın.

ikas'a bağlanmadan denemek: `IKAS_MOCK=1 ADMIN_PASSWORD=demo npm start` → `http://localhost:3000/demo` ve `/admin`.
Testler: `npm test`.

## Mail
- `MAIL_MODE=smtp` (varsayılan): sipariş maili dahil tüm mailleri modül SMTP ile gönderir.
- `MAIL_MODE=ikas`: sipariş bilgilendirmesi ikas'ın kendi sipariş mailine bırakılır; modül sadece hoş geldin/hatırlatma/iptal gönderir.
- SMTP tanımlı değilse mailler gönderilmez, panelde **Mail Kutusu**'nda görünür.

**Test sonucu:** ikas, API ile açılan siparişlerde müşteriye mail göndermiyor ve Admin API'de mail gönderen bir
mutation yok. Bu yüzden `MAIL_MODE=smtp` kullanılmalı. Önerilen sağlayıcı **Brevo** (`smtp-relay.brevo.com:587`),
gönderen adres mağaza alan adından olmalı. Panel > Mail Kutusu > "Test maili gönder" ile kontrol edilebilir.

## Canlıya almadan önce ikas'ta doğrulanacaklar
API dokümanından alınan alan adları kullanıldı ama gerçek mağazada denenmedi:
- `listProduct` alanları: `metaData.slug`, `variants.prices.sellPrice/discountPrice`, `variantValues.variantValueName`.
- `listPaymentGateway` ve `listStorefront` sorguları (panelde hata verirse ID'yi elle girmek gerekir).
- `createOrderWithTransactions`: `price` = liste fiyatı, `discountPrice` = abonelik fiyatı olarak gönderiliyor; siparişte tutarların doğru göründüğünü kontrol edin.
  Kargo ücreti (`shippingLines`) şu an gönderilmiyor.
- Adres: il/ilçe isimle gönderiliyor (`city.name`, `district.name`); ikas ID isterse eşleme eklenmeli.
- Ürün sayfasında ürün, URL slug'ı ile bulunuyor; widget "Sepete Ekle" butonunu metinden arar. Tema farklıysa panelde
  "Yerleşim CSS seçicisi" girin.

## Yapı
```
src/server.js         HTTP sunucusu, panel ve mağaza API'leri, zamanlayıcı
src/subscriptions.js  abonelik oluşturma, sipariş açma, erteleme/iptal, zamanlayıcı turu
src/ikas.js           ikas Admin GraphQL istemcisi (+ mock)
src/mailer.js         mail şablonları ve gönderim
src/manage.js         müşteri abonelik yönetim sayfası (/s/:token)
src/db.js, dates.js   SQLite (node:sqlite) ve tarih hesapları
public/               widget.js, admin.html, demo.html
```
