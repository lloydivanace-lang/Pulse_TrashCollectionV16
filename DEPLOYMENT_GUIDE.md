# P.U.L.S.E. - Barangay 40 & 41, Cavite City
## Opisyal na Gabay sa Pag-deploy sa Render.com at GitHub

Ang **P.U.L.S.E. (Public Unified Logistics & Service Engine)** ay handa na para sa 24/7 libreng produksyon sa **Render.com** gamit ang iyong GitHub repository: `https://github.com/lloydivanace-lang/Pulse_TrashCollectionV15`.

---

### Solusyon sa Render Error: `bash: line 1: nmp: command not found`

Kung nakaranas ka ng:
```
==> Running 'nmp start'
bash: line 1: nmp: command not found
==> Exited with status 127
```

**Dahilan:**
Nagkaroon ng munting typo sa Render Dashboard: na-type ang **`nmp`** sa halip na **`npm`**.

**Solusyon (2-Hakbang):**
1. Pumunta sa iyong **Render Dashboard** (https://dashboard.render.com).
2. Piliin ang iyong Web Service (`pulse-barangay40-41` o katulad).
3. Pumunta sa **Settings** tab.
4. Hanapin ang **Start Command** at palitan ito:
   - ❌ MALI: `nmp start`
   - ✅ TAMA: `npm start`
5. Pindutin ang **Save Changes** at mag-click ng **Manual Deploy > Deploy latest commit**.

---

### Kumpletong Render.com Settings:

| Setting | Halaga |
|---|---|
| **Runtime / Environment** | `Node` |
| **Node Version** | `20` o `22` o `24` |
| **Branch** | `main` |
| **Build Command** | `npm install --legacy-peer-deps && npm run build` |
| **Start Command** | `npm start` *(Tiyaking 'npm' at hindi 'nmp')* |
| **Plan Type** | `Free` |

---

### Raspberry Pi 4B Cloud Server:
- **Default Server URL:** `https://overvalue-jawed-footage.ngrok-free.dev`
- Naka-setup nang maayos sa parehong client at server na may `ngrok-skip-browser-warning: 69420` headers.
- Maaaring palitan, i-konekta, o tanggalin anumang oras sa Kagawad Portal > Raspberry Pi tab.

### Kagawad Portal Default Credentials:
- **Username:** `kagawad41` o `kagawad40` o `admin`
- **Password:** `Kagawad@Cavite2026#Brgy41!`
*(Maaaring palitan anumang oras sa Kagawad Portal settings).*
