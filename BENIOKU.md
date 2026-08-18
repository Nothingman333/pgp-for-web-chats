# PGP for Web Chats — Türkçe Kılavuz

**WhatsApp Web, Discord, Gmail ve herhangi bir web yazışma kutusunda** mesajlarınızı
PGP ile şifreler. Karşı tarafta aynı eklenti varsa düz metni otomatik görür.
Her şey tarayıcınızda olur; sunucu yok, hesap yok.

---

## Kurulum

1. `chrome://extensions` adresini açın
2. Sağ üstten **Geliştirici modu**'nu açın
3. **Paketlenmemiş öğe yükle** → bu klasörü seçin
4. Zaten kuruluysa karttaki **yenile (↻)** simgesine basın, sonra açık sekmeleri F5 yapın

Arayüz **varsayılan olarak İngilizce**. Eklenti penceresinin üstündeki açılır
listeden **Türkçe**'ye geçebilirsiniz.

---

## 1. Anahtarınızı oluşturun

Eklenti simgesi → **Anahtarım** → **Anahtar Oluştur**.

Sonra açık anahtarınızı **Kopyala** veya **Dosya Olarak İndir** ile karşı tarafa
iletin (sohbetin kendisi dışında bir kanaldan, örneğin e-posta ile).

## 2. Karşı tarafı ekleyin

Eklenti simgesi → **Kişiler** → bir ad yazın, onun açık anahtarını yapıştırın veya
dosyadan yükleyin → **Kişiyi Kaydet**.

## 3. Şifreli yazın

Herhangi bir sitede yazma kutusuna tıklayın — yanında küçük bir **🔒 düğmesi**
belirir. Üzerine gelince panel açılır (tıklarsanız açık kalır).

Alıcıyı seçin, mesajı yazın, **Enter**'a basın.

- **WhatsApp, Discord, Slack, Telegram** → şifreli metin kutuya yazılır ve **otomatik gönderilir**
- **Gmail ve diğer siteler** → şifreli metin **sadece yerleştirilir**; göndermeye siz karar verirsiniz

🔒 düğmesini sürükleyerek paneli istediğiniz yere taşıyabilirsiniz.

## 4. Okuma

Sayfadaki PGP mesajları otomatik bulunup çözülür. Her birinin köşesinde küçük bir
nokta belirir:

| Nokta | Anlamı |
|-------|--------|
| 🟢 yeşil | çözüldü — şifreli metin yerine düz mesaj gösteriliyor |
| 🟡 sarı | anahtarınız var ama bu mesaj ona şifrelenmemiş |
| 🔴 kırmızı | bu mesajı çözecek bir anahtarınız yok |

Sarı ve kırmızıda mesajın üstünde sebebi açıklayan kısa bir uyarı çıkar.

Bir mesaj otomatik çözülmezse panelin **Çöz** sekmesini açın: metni sayfada seçip
*Seçtiğim metni çöz*'e basın, ya da bloğu kutuya yapıştırıp **Çöz**'e basın.

---

## Şifreli resim

Bir resmi şifreli **metin** olarak göndermek mümkün değil — 500 KB'lık bir resmin
armored hali yaklaşık 700 bin karakter eder, WhatsApp ~65 bin, Discord 2 bin
karaktere izin verir. Bu yüzden resimler **dosya olarak** şifrelenir:

1. Panel → **Yaz** sekmesi → **Resim şifrele ve ekle** → resmi seçin
2. Eklenti şifreler ve `.pgp` dosyasını sitenin kendi yükleme mekanizmasına verir
   (WhatsApp'ta bunun yerine indirir — 📎 → **Belge** ile ekleyin, çünkü WhatsApp
   sürükle-bırakta bilinmeyen dosya türlerini reddediyor)
3. Karşı taraf dosyayı indirip panelin **Çöz** sekmesinden
   **Şifreli dosya/resim aç** ile açar. Resim orada görünür ve kaydedilebilir.

Not: resim çözme **otomatik değildir**. Eklenti WhatsApp/Discord sunucularındaki
eklere erişemediği için bu iki adımı karşı taraf elle yapar.

---

## Anahtar koruması (v3)

**Ayarlar → Anahtar koruması**'ndan açılır. Açıkken özel anahtarınız ve kişi listeniz
**PBKDF2 (300.000 iterasyon) + AES-256-GCM** ile şifreli saklanır. Türetilmiş anahtar diske asla
yazılmaz; oturum belleğinde durur ve hareketsizlik süresi dolunca (varsayılan 15 dk) ya da tarayıcı
kapanınca silinir. Eklenti simgesine sağ tıklayınca **Lock now** çıkar.

Koruma kapalıyken özel anahtar tarayıcı deposunda düz metin durur — bilgisayara erişen herkes
kopyalayabilir. Kapatmaya çalışınca açık bir uyarı çıkar ve parola sorulur.

Sayfadaki panel **kapalı Shadow DOM** içinde; sayfanın kendi script'leri içeriğini okuyamaz.

## Yedekleme — önemli

Eklentiyi yeniden kurmak ya da başka bilgisayara geçmek tarayıcı deposunu siler.
**Anahtarınızı kaybederseniz eski şifreli mesajlarınızı bir daha asla açamazsınız.**

Eklenti simgesi → **Yedek**:

- **Dışa Aktar** — anahtar çiftinizi *ve* tüm kişileri tek dosyaya yazar.
  "Parola ile koru" işaretliyse şifreli `.asc`, değilse sade `.json` iner.
- **İçe Aktar** — o dosyayı seçin (parolalıysa parolayı girin), her şey geri gelir.
  "Mevcut kişileri koru" işaretliyse eldeki kişiler silinmez.

Güncellemeden veya anahtar silmeden önce mutlaka yedek alın.

---

## Aç/kapa ve sıfırlama

- Pencerenin üstündeki anahtar eklentiyi tüm sitelerde anında kapatır: düğme
  kaybolur, noktalar silinir, çözülmüş mesajlar şifreli haline döner.
- **Yedek → Her Şeyi Sıfırla** anahtarı, tüm kişileri ve ayarları siler.
  Yanlışlıkla basılamasın diye zor: kutuya tam olarak `SIFIRLA` yazmanız, sonra
  ikinci bir onay penceresini geçmeniz gerekir. **Geri alınamaz.**

---

## Kendi kendine test

**Kişiler** → **Kendimi Kişi Olarak Ekle (test)** → panelde alıcı olarak
*Kendim (test)* seçip kendinize mesaj gönderin. Yeşil nokta ve okunur metin
görüyorsanız zincir baştan sona çalışıyor demektir.

---

## Bilinen sınırlar

- **Anahtar koruması kapalıyken** özel anahtar tarayıcı deposunda düz metin durur ve
  bilgisayarınıza erişen biri kopyalayabilir. Ayarlar'dan korumayı açın.
  Yedeklerinizi her hâlükârda parolalı alın.
- Mesajlar şifreleniyor ama **imzalanmıyor** — kimin gönderdiğini doğrulayamazsınız.
- Anahtar takasının doğrulaması yok: parmak izlerini güvendiğiniz bir kanaldan
  karşılaştırın, yoksa araya giren biri kendi anahtarını koyup her şeyi okuyabilir.
- Üstveri (kim kiminle, ne zaman) platforma açık kalır.
- Bu araç güvenlik denetiminden geçmedi. Hayati gizlilik için Signal ya da GnuPG kullanın.
- Farklı ya da eski bir anahtarla şifrelenmiş mesajlar sarı kalır; bu normaldir.
- Grup sohbeti desteklenmez; her mesaj tek bir alıcıya (artı kendinize, gönderdiğinizi
  sonradan okuyabilmeniz için) şifrelenir.
- Web sohbet arayüzleri sık değişir. Bir site çalışmaz olursa bakılacak yer
  `content/content.js` içindeki seçicilerdir.
