# automation-tcg

Pokémon TCG kartlarını [kartfiyat.com](https://kartfiyat.com) üzerinden arayıp ikas mağazasına ürün olarak yükleyen ve fiyatları otomatik güncelleyen otomasyon sistemi.

## Özellikler

- Kart arama ve ikas'a tek tıkla import
- Set bazlı kategori ataması (Japonca setler dahil)
- EAN-13 barkod üretimi
- 24 saatte bir fiyat kontrolü ve %10+ değişim onayı
- Admin paneli ile kimlik doğrulamalı erişim

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasını doldurun
npm start
```

Panel: `http://localhost:3000/login.html`

## Ortam Değişkenleri

`.env.example` dosyasındaki tüm anahtarları doldurun. Özellikle:

| Değişken | Açıklama |
|----------|----------|
| `IKAS_CLIENT_ID` / `IKAS_CLIENT_SECRET` | ikas API kimlik bilgileri |
| `KARTFIYAT_API_TOKEN` | kartfiyat.com API token |
| `ADMIN_USERS` | İlk admin kullanıcıları (`kullanici:sifre`) |
| `FINAL_COST_MULTIPLIER` | Fiyat çarpanı (varsayılan: 1.86) |

## Komutlar

```bash
npm start              # Sunucuyu başlat
npm run restart        # Yeniden başlat
npm run sets:sync      # Set kodlarını senkronize et
npm run price:check    # Fiyat kontrolünü manuel çalıştır
npm run admin:create -- kullanici sifre   # Yeni admin ekle
```

## Fiyat Formülü

```
Nihai Fiyat (TL) = ⌈(PriceCharting USD × Güncel Dolar Kuru) × 1.86⌉
```

Fiyat tam TL'ye yukarı yuvarlanır (ör. 764,68 → 765).
