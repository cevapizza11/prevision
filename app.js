// ============================================================
// CONFIG FIREBASE
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyDhqKmCJJx5ScXUxaoip1eMiy10P0BvD9U",
  authDomain: "marmite-bleue.firebaseapp.com",
  projectId: "marmite-bleue",
  storageBucket: "marmite-bleue.firebasestorage.app",
  messagingSenderId: "938472624829",
  appId: "1:938472624829:web:edd7453c2589c820dfddd4"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ============================================================
// DONNÉES RÉELLES — LIAISON AVEC L'APPLI DE COMMANDE MOULE & SMILE (17/10/2026)
// ------------------------------------------------------------
// Chaque journée de service terminée est relue dans l'appli de commande
// (projet Firebase « commandemoulesmile », en LECTURE SEULE) puis résumée
// dans ce projet, collection « journees_reelles » (un document par jour) :
//   - CA réel     = montant des tables encaissées (« visites », créées à chaque encaissement ;
//                   repas employés exclus). Si l'historique des encaissements donne plus
//                   (table sans heure d'arrivée), c'est lui qui est retenu.
//   - tables      = nombre de tables encaissées (même règle)
//   - couverts    = somme des couverts saisis sur les jetons (collection « visites »)
//   - créneaux    = arrivées (couverts) et CA par tranche de 30 min, d'après
//                   l'heure d'arrivée de la table (création du jeton)
// Une journée de service va de 5 h du matin à 5 h le lendemain (comme la caisse).
// Seules les journées TERMINÉES sont résumées (jamais la journée en cours).
// Les prévisions utilisent ensuite ces journées à la place des estimations.
// ============================================================
const BUILD_VERSION = "v.17/10/2026 17:40";
const VERSION_CALCUL = 2; // changer ce numéro force un recalcul complet de toutes les journées

const FIREBASE_MOULE_CONFIG = {
  apiKey: "AIzaSyDUb3LtVsMAq986DgtHwkMBeQFr8A8A2nU",
  authDomain: "commandemoulesmile.firebaseapp.com",
  projectId: "commandemoulesmile",
  storageBucket: "commandemoulesmile.firebasestorage.app",
  messagingSenderId: "303564394584",
  appId: "1:303564394584:web:cbde6960f99cac83517a2d"
};
const EMAIL_EQUIPE_MOULE = "mouleandsmile11@gmail.com";
const HEURE_COUPURE_SERVICE = 5;        // une journée de service commence à 5 h
const JOURS_PREMIERE_SYNCHRO = 400;     // 1re synchro : on remonte jusqu'à ~13 mois en arrière
const JOURNEES_REELLES = "journees_reelles";

// Calendrier Moule & Smile
// Pleine saison : 10 juillet → 23 août. Moyenne : juin, 1-9 juillet, 24 août → septembre.
// Basse : mars, avril, mai, octobre. Fermé : novembre → février.
function saisonPour(date) {
  const m = date.getMonth(), j = date.getDate();
  if ((m === 6 && j >= 10) || (m === 7 && j <= 23)) return 'haute';
  if (m >= 5 && m <= 8) return 'moyenne';
  return 'basse';
}
// Ouverture : mars ven-dim · avril et octobre mer-dim · mai → septembre tous les jours
function ouvertLe(date) {
  const m = date.getMonth(), js = date.getDay();
  if (m === 10 || m === 11 || m === 0 || m === 1) return false;
  if (m === 2) return [5, 6, 0].includes(js);
  if (m === 3 || m === 9) return [3, 4, 5, 6, 0].includes(js);
  return true;
}

// "2026-07-14" pour la journée de service à laquelle appartient un instant (coupure 5 h)
function jourServiceDe(ms) {
  const d = new Date(ms - HEURE_COUPURE_SERVICE * 3600 * 1000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Instant de début (5 h) d'une journée de service "AAAA-MM-JJ"
function debutJourService(dateStr) {
  const [a, m, j] = dateStr.split('-').map(Number);
  return new Date(a, m - 1, j, HEURE_COUPURE_SERVICE, 0, 0, 0).getTime();
}
function ajouterJours(dateStr, n) {
  const [a, m, j] = dateStr.split('-').map(Number);
  const d = new Date(a, m - 1, j + n, 12);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Créneau de 30 min (11.5 = 11h30) — borné aux heures d'ouverture 11h30 → 23h
function creneauDe(ms) {
  const d = new Date(ms);
  let h = d.getHours() + (d.getMinutes() >= 30 ? 0.5 : 0);
  if (h < HEURE_COUPURE_SERVICE) h += 24; // après minuit = fin de service
  return Math.min(23, Math.max(11.5, h));
}
function libelleCreneau(h) { return Math.floor(h) + 'h' + (h % 1 ? '30' : '00'); }
function msDe(ts) { return ts && ts.toMillis ? ts.toMillis() : (typeof ts === 'number' ? ts : null); }

const Reel = {
  app: null, auth: null, dbMoule: null, user: null,
  statut: 'deconnecte',   // 'deconnecte' | 'pret' | 'synchro' | 'erreur'
  erreur: '',
  journees: [],           // journées réelles chargées depuis ce projet
  derniereSynchro: null,

  init() {
    if (this.app) return true;
    try {
      this.app = firebase.apps.find(a => a.name === 'moule') || firebase.initializeApp(FIREBASE_MOULE_CONFIG, 'moule');
      this.auth = this.app.auth();
      this.dbMoule = this.app.firestore();
      this.auth.onAuthStateChanged(u => {
        this.user = (u && !u.isAnonymous) ? u : null;
        this.statut = this.user ? 'pret' : 'deconnecte';
        this.afficherEtat();
        if (this.user && auth.currentUser) this.synchroniser(false);
      });
      return true;
    } catch (e) {
      console.error("Liaison appli de commande — initialisation impossible :", e);
      this.statut = 'erreur'; this.erreur = "Initialisation impossible";
      return false;
    }
  },

  async connecter() {
    const champ = document.getElementById('reelPwd');
    const pwd = champ ? champ.value : '';
    if (!pwd) { showToast("Entre le mot de passe équipe de la caisse Moule & Smile", "error"); return; }
    if (!this.init()) return;
    try {
      await this.auth.signInWithEmailAndPassword(EMAIL_EQUIPE_MOULE, pwd);
      if (champ) champ.value = '';
      showToast("✅ Liaison activée — récupération des journées réelles…");
    } catch (e) {
      console.error(e);
      showToast("❌ Mot de passe incorrect ou pas d'internet", "error");
    }
  },

  async deconnecter() {
    if (!confirm("Couper la liaison avec l'appli de commande sur cet appareil ?")) return;
    try { await this.auth.signOut(); } catch (e) {}
  },

  // Charge les journées réelles déjà résumées dans ce projet
  async chargerJournees() {
    try {
      const snap = await db.collection(JOURNEES_REELLES).get();
      this.journees = snap.docs.map(d => d.data()).filter(j => j && j.dateStr)
        .sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    } catch (e) {
      console.error("Lecture journées réelles impossible :", e);
    }
    return this.journees;
  },

  // Relit l'appli de commande depuis la dernière journée résumée et crée/complète
  // les journées terminées. Sans danger si on l'appelle plusieurs fois.
  async synchroniser(avecMessage) {
    if (!this.user || this.statut === 'synchro') { await this.chargerJournees(); this.afficherEtat(); return; }
    this.statut = 'synchro'; this.afficherEtat();
    try {
      const cfgRef = db.collection("config").doc("syncAppliCommande");
      const cfg = await cfgRef.get();
      const jourEnCours = jourServiceDe(Date.now());
      // Si la méthode de calcul a changé, on recalcule toutes les journées depuis le début
      const dernierFait = (cfg.exists && cfg.data().versionCalcul === VERSION_CALCUL) ? cfg.data().dernierJourComplet : null;
      const premierJour = dernierFait ? ajouterJours(dernierFait, 1) : ajouterJours(jourEnCours, -JOURS_PREMIERE_SYNCHRO);
      if (premierJour >= jourEnCours) { // rien de nouveau : la journée en cours n'est jamais résumée
        await this.chargerJournees();
        this.derniereSynchro = Date.now(); this.statut = 'pret'; this.afficherEtat();
        if (avecMessage) showToast("✅ Déjà à jour");
        return;
      }
      const debut = firebase.firestore.Timestamp.fromMillis(debutJourService(premierJour));
      const fin = firebase.firestore.Timestamp.fromMillis(debutJourService(jourEnCours));

      const [snapHisto, snapVisites] = await Promise.all([
        this.dbMoule.collection('historique').where('timestamp', '>=', debut).where('timestamp', '<', fin).get(),
        this.dbMoule.collection('visites').where('heureDepart', '>=', debut).where('heureDepart', '<', fin).get()
      ]);

      const jours = {};
      const jourVide = (dateStr) => jours[dateStr] || (jours[dateStr] = {
        dateStr, ca: 0, tables: 0, caVisites: 0, couverts: 0, couvertsRepas: 0, tablesSansCouverts: 0, visites: 0, creneaux: {}
      });

      // Encaissements : CA et nombre de tables
      snapHisto.forEach(doc => {
        const h = doc.data();
        if (h.type === 'employe' || h.modePaiement === 'offert') return;       // repas offert
        if (!Array.isArray(h.paiements) || !h.paiements.length) return;        // commande archivée / ancien format
        const ms = h.encaisseLeMs || msDe(h.timestamp);
        if (!ms) return;
        const j = jourVide(jourServiceDe(ms));
        j.ca += Number(h.total) || 0;
        j.tables++;
      });

      // Visites : couverts et arrivées par créneau
      snapVisites.forEach(doc => {
        const v = doc.data();
        if (v.table >= 500) return; // repas employé (numéro de table virtuel 500+)
        const msArr = msDe(v.heureArrivee) || msDe(v.heureDepart);
        if (!msArr) return;
        const j = jourVide(jourServiceDe(msDe(v.heureDepart) || msArr));
        const c = Number(v.couverts) || 0;
        j.visites++;
        j.caVisites += Number(v.total) || 0;
        if (!c) j.tablesSansCouverts++;
        j.couverts += c;
        if (v.type !== 'boisson') j.couvertsRepas += c;
        const cle = creneauDe(msArr).toFixed(1);
        const cr = j.creneaux[cle] || (j.creneaux[cle] = { arrivees: 0, ca: 0, tables: 0 });
        cr.arrivees += c; cr.tables++; cr.ca += Number(v.total) || 0;
      });

      // Enregistre une journée par document (les journées sans aucune vente = fermées, pas de document)
      const lots = [];
      let batch = db.batch(), n = 0;
      Object.values(jours).forEach(j => {
        if (!j.tables && !j.visites) return;
        j.caRetenu = Math.max(j.ca, j.caVisites);
        // Tables sans couverts renseignés : on les compte avec la moyenne des autres tables
        const moyCouverts = (j.visites - j.tablesSansCouverts) > 0 ? j.couverts / (j.visites - j.tablesSansCouverts) : 2;
        const couvertsEstimes = Math.round(j.couverts + j.tablesSansCouverts * moyCouverts);
        const d = new Date(j.dateStr + "T12:00:00");
        batch.set(db.collection(JOURNEES_REELLES).doc(j.dateStr), {
          dateStr: j.dateStr,
          date: d,
          jourSemaine: d.getDay(),
          saison: saisonPour(d),
          ca: Math.round(Math.max(j.ca, j.caVisites) * 100) / 100,
          tables: Math.max(j.tables, j.visites),
          couverts: couvertsEstimes,
          couvertsRepas: j.couvertsRepas,
          tablesSansCouverts: j.tablesSansCouverts,
          panierCouvert: couvertsEstimes ? Math.round(j.caRetenu / couvertsEstimes * 100) / 100 : null,
          creneaux: j.creneaux,
          source: 'appli de commande',
          majLe: Date.now()
        });
        if (++n >= 400) { lots.push(batch); batch = db.batch(); n = 0; }
      });
      lots.push(batch);
      for (const b of lots) await b.commit();
      await cfgRef.set({ dernierJourComplet: ajouterJours(jourEnCours, -1), versionCalcul: VERSION_CALCUL, majLe: Date.now() });

      await this.chargerJournees();
      this.derniereSynchro = Date.now();
      this.statut = 'pret'; this.erreur = '';
      const nb = Object.values(jours).filter(j => j.tables || j.visites).length;
      if (avecMessage || nb) showToast(nb ? `✅ ${nb} journée${nb > 1 ? 's' : ''} réelle${nb > 1 ? 's' : ''} ajoutée${nb > 1 ? 's' : ''}` : "✅ Déjà à jour");
    } catch (e) {
      console.error("Synchronisation appli de commande :", e);
      this.statut = 'erreur';
      this.erreur = e && e.code === 'permission-denied' ? "Accès refusé (règles Firestore ou liaison à refaire)" : "Synchronisation impossible (internet ?)";
      showToast("❌ " + this.erreur, "error");
    }
    this.afficherEtat();
  },

  // Recalcule tout depuis le début (si une correction a été faite après coup)
  async toutRecalculer() {
    if (!confirm("Relire toutes les journées depuis le début dans l'appli de commande ? (utile après une correction)")) return;
    try { await db.collection("config").doc("syncAppliCommande").delete(); } catch (e) {}
    this.synchroniser(true);
  },

  libelleStatut() {
    if (this.statut === 'synchro') return "🟡 Synchronisation en cours…";
    if (this.statut === 'erreur') return "🔴 " + this.erreur;
    if (this.statut === 'pret') return "🟢 Liaison active avec l'appli de commande";
    return "🔴 Liaison non connectée sur cet appareil";
  },

  // Met à jour la carte d'état (onglet Prévisions) et la carte de connexion (Réglages)
  afficherEtat() {
    const el = document.getElementById('reelEtat');
    if (el) {
      const js = this.journees;
      const dernieres = js.slice(-7).reverse();
      el.innerHTML = `
        <p style="font-size:0.85rem;margin-bottom:8px;"><strong>${this.libelleStatut()}</strong></p>
        <p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:10px;">
          ${js.length} journée${js.length > 1 ? 's' : ''} réelle${js.length > 1 ? 's' : ''} enregistrée${js.length > 1 ? 's' : ''}
          ${this.derniereSynchro ? ' · synchro à ' + new Date(this.derniereSynchro).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}
        </p>
        ${dernieres.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Journée</th><th>Couverts</th><th>Tables</th><th>CA réel</th><th>Panier / couvert</th></tr></thead>
          <tbody>${dernieres.map(j => `<tr>
            <td>${new Date(j.dateStr + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</td>
            <td style="color:var(--gold);font-weight:600;">${j.couverts}</td>
            <td>${j.tables}</td>
            <td>${formatEuro(j.ca || 0)}</td>
            <td>${j.panierCouvert ? formatEuro(j.panierCouvert) : '—'}</td></tr>`).join('')}</tbody>
        </table></div>` : `<p class="empty-state">Aucune journée réelle pour l'instant — elles arriveront après les premiers services.</p>`}
        ${this.user ? `<button class="btn btn-secondary" style="margin-top:10px;" onclick="Reel.synchroniser(true)">🔄 Synchroniser maintenant</button>`
                    : `<p style="font-size:0.8rem;color:var(--text-secondary);margin-top:8px;">Active la liaison dans ⚙️ Réglages.</p>`}`;
    }
    const r = document.getElementById('reelConnexion');
    if (r) {
      r.innerHTML = `
        <p style="font-size:0.85rem;margin-bottom:10px;"><strong>${this.libelleStatut()}</strong></p>
        ${this.user ? `
          <button class="btn btn-secondary" onclick="Reel.toutRecalculer()">🔁 Tout recalculer depuis le début</button>
          <button class="btn btn-secondary" onclick="Reel.deconnecter()">Couper la liaison sur cet appareil</button>
        ` : `
          <div class="form-group">
            <label>Mot de passe équipe de la caisse Moule &amp; Smile</label>
            <input id="reelPwd" type="password" autocomplete="off" placeholder="Le même que sur caisse.html">
          </div>
          <button class="btn btn-primary" onclick="Reel.connecter()">🔗 Activer la liaison</button>
        `}`;
    }
  }
};

// ------------------------------------------------------------
// CALCULS À PARTIR DES JOURNÉES RÉELLES
// ------------------------------------------------------------
// Journées comparables : même jour de la semaine ET même saison.
function journeesComparables(jourSemaine, saison) {
  return Reel.journees.filter(j => j.jourSemaine === jourSemaine && j.saison === saison && j.couverts > 0);
}
// Poids des données réelles selon leur nombre (même règle que l'historique saisi)
function poidsReel(n) { return n >= 15 ? 0.80 : n >= 5 ? 0.50 : n >= 1 ? 0.20 : 0; }

// Part de chaque créneau de 30 min dans les arrivées de la journée (vraie courbe).
// On prend les journées comparables ; s'il y en a moins de 3, toutes les journées de la saison,
// puis toutes les journées.
function courbeReelle(jourSemaine, saison) {
  let base = journeesComparables(jourSemaine, saison);
  let source = 'même jour + même saison';
  if (base.length < 3) { base = Reel.journees.filter(j => j.saison === saison && j.couverts > 0); source = 'même saison'; }
  if (base.length < 3) { base = Reel.journees.filter(j => j.couverts > 0); source = 'toutes les journées'; }
  if (!base.length) return null;
  const parts = {};
  base.forEach(j => {
    const total = Object.values(j.creneaux || {}).reduce((s, c) => s + (c.arrivees || 0), 0);
    if (!total) return;
    Object.entries(j.creneaux).forEach(([k, c]) => { parts[k] = (parts[k] || 0) + (c.arrivees || 0) / total; });
  });
  const nbJours = base.filter(j => Object.values(j.creneaux || {}).some(c => c.arrivees > 0)).length;
  if (!nbJours) return null;
  Object.keys(parts).forEach(k => { parts[k] = parts[k] / nbJours; });
  return { parts, nbJours, source };
}

// Panier moyen réel par couvert sur les journées comparables (null si moins de 5 journées)
// ------------------------------------------------------------
// EFFET « PÉRIODE » APPRIS SUR LE RÉEL (se met en route tout seul)
// Pleine saison : avant / après le 15 août. Autres saisons : début (1-10),
// milieu (11-20), fin (21-31) du mois.
// Pour chaque journée réelle de la saison, on mesure son écart à la moyenne des
// journées du même jour de la semaine (ex. ce samedi / moyenne des samedis), puis on
// fait la moyenne de ces écarts par période. Rien n'est appliqué tant qu'une période
// a moins de 5 journées ; ensuite 50 % de l'effet (5 à 14 journées), puis 80 % (15 et plus).
// Un seul effet à la fois (pas de cumul fin de mois + après 15 août).
// ------------------------------------------------------------
const MIN_JOURNEES_EFFET_PERIODE = 5;
function periodeDe(date, saison) {
  if (saison === 'haute') {
    const apres15 = date.getMonth() === 7 && date.getDate() > 15;
    return { cle: apres15 ? 'apres15aout' : 'avant15aout', libelle: apres15 ? 'après le 15 août' : 'avant le 16 août' };
  }
  const j = date.getDate();
  if (j <= 10) return { cle: 'debut', libelle: 'début de mois (1-10)' };
  if (j <= 20) return { cle: 'milieu', libelle: 'milieu de mois (11-20)' };
  return { cle: 'fin', libelle: 'fin de mois (21-31)' };
}
function effetPeriode(date, saison) {
  const cible = periodeDe(date, saison);
  const jours = Reel.journees.filter(j => j.saison === saison && j.couverts > 0);
  // moyenne par jour de la semaine (référence)
  const moyJS = {};
  jours.forEach(j => { (moyJS[j.jourSemaine] = moyJS[j.jourSemaine] || []).push(j.couverts); });
  Object.keys(moyJS).forEach(k => { const a = moyJS[k]; moyJS[k] = a.length >= 2 ? a.reduce((s, x) => s + x, 0) / a.length : null; });
  const ratios = jours
    .filter(j => moyJS[j.jourSemaine] && periodeDe(new Date(j.dateStr + "T12:00:00"), saison).cle === cible.cle)
    .map(j => j.couverts / moyJS[j.jourSemaine]);
  const n = ratios.length;
  if (n < MIN_JOURNEES_EFFET_PERIODE) {
    return { facteur: 1, actif: false, n, libelle: cible.libelle };
  }
  const brut = ratios.reduce((s, x) => s + x, 0) / n;
  const poids = n >= 15 ? 0.80 : 0.50;
  return { facteur: 1 + (brut - 1) * poids, brut, poids, actif: true, n, libelle: cible.libelle };
}

function panierReel(jourSemaine, saison) {
  let base = journeesComparables(jourSemaine, saison);
  if (base.length < 5) base = Reel.journees.filter(j => j.saison === saison && j.couverts > 0);
  if (base.length < 5) return null;
  const ca = base.reduce((s, j) => s + (j.ca || 0), 0), cv = base.reduce((s, j) => s + (j.couverts || 0), 0);
  return cv ? { valeur: Math.round(ca / cv * 100) / 100, nb: base.length } : null;
}


let chartStats = null;
let chartAvis = null;
let currentTab = 'dashboard';
let panierMoyenGlobal = 20;
// Effectif minimum présent pendant toute l'ouverture (réglable dans Réglages, 0 = aucun minimum).
// Équipe minimum : 1 marmite + 1 friteuse + 1 salle, puis salle / bar en alternance au-delà de 3.
let effectifMinGlobal = 3;

// ============================================================
// NAVIGATION TABS
// ============================================================
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('nav-' + tab).classList.add('active');

  if (tab === 'dashboard') chargerDashboard();
  if (tab === 'avis') chargerAvis();
  if (tab === 'reglages') chargerReglages();
  if (tab === 'import') initImport();
  if (tab === 'previsions') initPrevisions();
  if (tab === 'semaine') initSemaine();
}

// ============================================================
// LOGIN / LOGOUT
// ============================================================
function login() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const btn = document.getElementById("loginBtn");
  btn.textContent = "Connexion...";
  btn.disabled = true;

  auth.signInWithEmailAndPassword(email, password)
    .catch(error => {
      showToast("❌ " + traduireErreur(error.code), "error");
      btn.textContent = "Connexion";
      btn.disabled = false;
    });
}

function logout() {
  auth.signOut();
}

function traduireErreur(code) {
  const map = {
    'auth/wrong-password': 'Mot de passe incorrect',
    'auth/user-not-found': 'Utilisateur introuvable',
    'auth/invalid-email': 'Email invalide',
    'auth/too-many-requests': 'Trop de tentatives, réessaie plus tard'
  };
  return map[code] || 'Erreur de connexion';
}

// ============================================================
// AUTH STATE
// ============================================================
auth.onAuthStateChanged(user => {
  if (user) {
    document.getElementById("loginBox").style.display = "none";
    document.getElementById("appWrapper").style.display = "block";
    document.getElementById("userEmail").textContent = user.email;
    showTab('dashboard');
    chargerReglagesInit();
    // Données réelles de l'appli de commande : chargement puis synchro si la liaison est active
    Reel.chargerJournees().then(() => { Reel.init(); Reel.afficherEtat(); if (Reel.user) Reel.synchroniser(false); });
  } else {
    document.getElementById("loginBox").style.display = "flex";
    document.getElementById("appWrapper").style.display = "none";
  }
});

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast show ' + type;
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// ============================================================
// ============================================================
// MODULE 1 : SAISIE OPÉRATIONNELLE
// ============================================================
// ============================================================

async function analyser() {
  const btn = document.getElementById("btnAnalyser");
  btn.textContent = "Analyse en cours...";
  btn.disabled = true;

  // Lecture champs
  const clients    = +document.getElementById("clients").value || 0;
  const avis       = +document.getElementById("avis").value || 0;
  const note       = +document.getElementById("note").value || 0;
  const attente    = +document.getElementById("attente").value || 0;
  const employe    = document.getElementById("employe").value.trim();
  const tempMoules = +document.getElementById("tempMoules").value || 0;
  const caReel        = +document.getElementById("caReel").value || 0;
  const caPrev        = +document.getElementById("caPrev").value || 0;
  const ruptures   = document.getElementById("ruptures").value.trim();
  const absences   = document.getElementById("absences").value.trim();

  // Calculs
  const taux = clients > 0 ? ((avis / clients) * 100).toFixed(1) : 0;
  const caRef = caPrev > 0 ? caPrev : (clients * panierMoyenGlobal);
  const ecartCA = caReel > 0 ? caReel - caRef : 0;

  // ---- SCORE SUR 100 ----
  // 1. Note Google → 40 pts (0-5 → 0-40)
  const ptsNote = note > 0 ? ((note / 5) * 40) : 0;

  // 2. Température moules → 25 pts
  //    ≥ 82°C = 25pts | 80-82 = 18pts | 75-80 = 10pts | <75 = 0pts | non saisi = 20pts (neutre)
  let ptsTemp = 20; // neutre si non saisi
  if (tempMoules > 0) {
    if (tempMoules >= 82)      ptsTemp = 25;
    else if (tempMoules >= 80) ptsTemp = 18;
    else if (tempMoules >= 75) ptsTemp = 10;
    else                       ptsTemp = 0;
  }

  // 3. Ruptures de stock → 15 pts
  //    Aucune rupture = 15pts | rupture = 5pts
  const hasRupture = ruptures && ruptures.toLowerCase() !== 'non' && ruptures.trim() !== '';
  const ptsRupture = hasRupture ? 5 : 15;

  // 4. Temps d'attente → 10 pts
  //    ≤ 3min = 10pts | ≤ 5min = 8pts | ≤ 8min = 5pts | >8min = 0pts | non saisi = 8pts
  let ptsAttente = 8;
  if (attente > 0) {
    if (attente <= 3)      ptsAttente = 10;
    else if (attente <= 5) ptsAttente = 8;
    else if (attente <= 8) ptsAttente = 5;
    else                   ptsAttente = 0;
  }

  // 5. CA réel vs prévisionnel → 7 pts
  //    Écart ≤ -10% = 0pts | -10% à 0% = 4pts | ≥ 0% = 7pts | non saisi = 4pts
  let ptsCA = 4;
  if (caReel > 0 && caRef > 0) {
    const pctEcart = (ecartCA / caRef) * 100;
    if (pctEcart >= 0)       ptsCA = 7;
    else if (pctEcart >= -10) ptsCA = 4;
    else                      ptsCA = 0;
  }

  // 6. Taux d'avis → 3 pts
  //    ≥ 10% = 3pts | ≥ 5% = 2pts | < 5% = 1pt | non saisi = 1pt
  let ptsTaux = 1;
  if (clients > 0) {
    if (parseFloat(taux) >= 10)     ptsTaux = 3;
    else if (parseFloat(taux) >= 5) ptsTaux = 2;
    else                            ptsTaux = 1;
  }

  const score = Math.round(ptsNote + ptsTemp + ptsRupture + ptsAttente + ptsCA + ptsTaux);
  const scoreDetail = { ptsNote, ptsTemp, ptsRupture, ptsAttente, ptsCA, ptsTaux };

  const data = {
    date: new Date(),
    clients, avis, note, attente, employe,
    tempMoules, caReel, ruptures, absences,
    taux: parseFloat(taux), score, scoreDetail, caPrev, caRef,
    ecartCA
  };

  try {
    await db.collection("stats").add(data);
    afficherResultat(data);
    showToast("✅ Journée enregistrée !");
    chargerDashboard();
    document.getElementById("formSaisie").reset();
  } catch(e) {
    console.error("ERREUR FIRESTORE stats:", e.code, e.message);
    showToast("❌ " + (e.message || "Erreur d'enregistrement"), "error");
  }

  btn.textContent = "Analyser la journée";
  btn.disabled = false;
}

// ============================================================
// AFFICHAGE RÉSULTAT + PLAN D'ACTION
// ============================================================
function afficherResultat(d) {
  const alertes = [];
  const actions = [];

  // --- Note Google
  if (d.note < 4.0) {
    alertes.push({ icon: "🔴", label: "Note critique", detail: `${d.note}/5` });
    actions.push({ priorite: "URGENT", texte: "Réunion équipe immédiate — identifier les réclamations récentes et revoir les process de service" });
  } else if (d.note < 4.5) {
    alertes.push({ icon: "🟡", label: "Note faible", detail: `${d.note}/5` });
    actions.push({ priorite: "AUJOURD'HUI", texte: "Vérifier les derniers avis Google — former l'équipe sur l'accueil et la qualité" });
  }

  // --- Taux d'avis
  if (d.taux < 5) {
    alertes.push({ icon: "🟡", label: "Peu d'avis récoltés", detail: `${d.taux}% des clients` });
    actions.push({ priorite: "CETTE SEMAINE", texte: "Activer la demande d'avis systématique à l'encaissement — afficher le QR code en salle" });
  }

  // --- Temps d'attente
  if (d.attente > 8) {
    alertes.push({ icon: "🔴", label: "Attente critique", detail: `${d.attente} min` });
    actions.push({ priorite: "URGENT", texte: "Analyser le goulot : friteuses ou chaudrons ? Envisager renfort production en peak" });
  } else if (d.attente > 5) {
    alertes.push({ icon: "🟡", label: "Attente élevée", detail: `${d.attente} min` });
    actions.push({ priorite: "DEMAIN", texte: "Revoir le flux de production — préchauffe des chaudrons anticipée" });
  }

  // --- Température moules
  if (d.tempMoules > 0) {
    if (d.tempMoules < 75) {
      alertes.push({ icon: "🔴", label: "Moules insuffisamment chaudes", detail: `${d.tempMoules}°C` });
      actions.push({ priorite: "URGENT", texte: "Contrôle immédiat chaudrons — vérifier thermostat et temps de cuisson — ne pas servir en dessous de 80°C à cœur" });
    } else if (d.tempMoules < 80) {
      alertes.push({ icon: "🟡", label: "Température moules limite", detail: `${d.tempMoules}°C` });
      actions.push({ priorite: "AUJOURD'HUI", texte: "Prolonger légèrement le temps de cuisson — revérifier à la prochaine fournée" });
    }
  }

  // --- CA réel vs théorique
  if (d.caReel > 0) {
    const caBase = (d.caPrev > 0) ? d.caPrev : (d.clients * panierMoyenGlobal);
    const ecartPct = caBase > 0 ? ((d.ecartCA / caBase) * 100).toFixed(1) : 0;
    if (d.ecartCA < -(d.clients * 12 * 0.1)) {
      alertes.push({ icon: "🔴", label: "CA réel bien en dessous du théorique", detail: `${d.ecartCA > 0 ? '+' : ''}${d.ecartCA}€ (${ecartPct}%)` });
      actions.push({ priorite: "AUJOURD'HUI", texte: "Vérifier la caisse — contrôle des formules jetons utilisées vs encaissements — possible erreur ou fraude" });
    } else if (d.ecartCA > (d.clients * 12 * 0.15)) {
      alertes.push({ icon: "🟢", label: "CA supérieur au théorique", detail: `+${d.ecartCA}€` });
      actions.push({ priorite: "INFO", texte: "Bonne performance — identifier ce qui a dopé les ventes (boissons, extras, événement ?)" });
    }
  }

  // --- Ruptures
  if (d.ruptures && d.ruptures.toLowerCase() !== 'non' && d.ruptures !== '') {
    alertes.push({ icon: "🟡", label: "Ruptures de stock", detail: d.ruptures });
    actions.push({ priorite: "DEMAIN MATIN", texte: `Commander en urgence : ${d.ruptures} — revoir les niveaux de stock minimum` });
  }

  // --- Absences
  if (d.absences && d.absences.toLowerCase() !== 'non' && d.absences !== '') {
    alertes.push({ icon: "🟡", label: "Absentéisme", detail: d.absences });
    actions.push({ priorite: "AUJOURD'HUI", texte: `Absence(s) : ${d.absences} — activer le plan de remplacement ou réorganiser les postes` });
  }

  // --- Tout OK
  if (alertes.length === 0) {
    alertes.push({ icon: "✅", label: "Tout est nominal", detail: "Bonne journée !" });
    actions.push({ priorite: "MAINTENIR", texte: "Performance au vert — capitaliser sur ce qui fonctionne, briefer l'équipe positivement" });
  }

  // Score badge
  const scoreColor = d.score >= 80 ? '#2ecc71' : d.score >= 50 ? '#f39c12' : '#e74c3c';
  document.getElementById("scoreBadge").textContent = d.score;
  document.getElementById("scoreBadge").style.background = scoreColor;
  const caRefAff = d.caRef || (d.clients * panierMoyenGlobal);
  const caRefLabel = (d.caPrev > 0) ? 'CA prévu' : 'CA estimé';
  const ecartAff = d.caReel > 0 ? (d.ecartCA >= 0 ? '+' : '') + d.ecartCA + '€' : '—';
  document.getElementById("caInfo").textContent =
    `CA réel : ${d.caReel > 0 ? d.caReel + '€' : 'non saisi'} | ${caRefLabel} : ${caRefAff}€ | Écart : ${ecartAff} | Avis : ${d.taux}%`;

  // Détail du score
  if (d.scoreDetail) {
    const sd = d.scoreDetail;
    document.getElementById("scoreDetail").innerHTML =
      `<span title="Note Google">⭐ ${sd.ptsNote.toFixed(0)}/40</span>
       <span title="Moules">🌡️ ${sd.ptsTemp}/25</span>
       <span title="Ruptures">📦 ${sd.ptsRupture}/15</span>
       <span title="Attente">⏱️ ${sd.ptsAttente}/10</span>
       <span title="CA">💶 ${sd.ptsCA}/7</span>
       <span title="Avis">💬 ${sd.ptsTaux}/3</span>`;
    document.getElementById("scoreDetail").style.display = "flex";
  }

  // Alertes
  document.getElementById("alertesList").innerHTML = alertes.map(a =>
    `<div class="alerte-item">
      <span class="alerte-icon">${a.icon}</span>
      <div><strong>${a.label}</strong><span class="alerte-detail">${a.detail}</span></div>
    </div>`
  ).join("");

  // Actions
  document.getElementById("actionsList").innerHTML = actions.map(a =>
    `<div class="action-item">
      <span class="action-prio prio-${a.priorite.toLowerCase().replace(/[^a-z]/g,'')}">${a.priorite}</span>
      <p>${a.texte}</p>
    </div>`
  ).join("");

  document.getElementById("resultatBox").style.display = "block";
  document.getElementById("resultatBox").scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
// DASHBOARD : charger stats + graphiques
// ============================================================
async function chargerDashboard() {
  try {
    const snapshot = await db.collection("stats").orderBy("date", "asc").get();
    const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (data.length === 0) {
      document.getElementById("dashStats").innerHTML = '<p class="empty-state">Aucune donnée encore. Faites votre première saisie !</p>';
      return;
    }

    // KPIs
    const derniere = data[data.length - 1];
    const notesMoy = (data.reduce((s, d) => s + (d.note || 0), 0) / data.length).toFixed(2);
    const attenteMoy = (data.reduce((s, d) => s + (d.attente || 0), 0) / data.length).toFixed(1);
    const totalClients = data.reduce((s, d) => s + (d.clients || 0), 0);

    // CA — uniquement journées avec CA réel saisi
    const joursAvecCA = data.filter(d => d.caReel > 0);
    const totalCA = joursAvecCA.reduce((s, d) => s + (d.caReel || 0), 0);
    const caMoyJour = joursAvecCA.length > 0 ? Math.round(totalCA / joursAvecCA.length) : 0;
    const totalClientsAvecCA = joursAvecCA.reduce((s, d) => s + (d.clients || 0), 0);
    const panierMoyenReel = totalClientsAvecCA > 0 ? (totalCA / totalClientsAvecCA).toFixed(2) : 0;

    document.getElementById("kpi-note").textContent = notesMoy;
    document.getElementById("kpi-attente").textContent = attenteMoy + " min";
    document.getElementById("kpi-clients").textContent = totalClients;
    document.getElementById("kpi-sessions").textContent = data.length;
    document.getElementById("kpi-ca-total").textContent = totalCA > 0 ? totalCA.toLocaleString('fr-FR') + " €" : "—";
    document.getElementById("kpi-ca-moy").textContent = caMoyJour > 0 ? caMoyJour + " €" : "—";
    document.getElementById("kpi-ca-moy-client").textContent = panierMoyenReel > 0 ? panierMoyenReel + " €" : "—";

    // Graphique notes
    const labels = data.map((d, i) => {
      if (d.date && d.date.toDate) return d.date.toDate().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      return `J${i+1}`;
    });
    const notes = data.map(d => d.note || 0);
    const scores = data.map(d => d.score || 0);

    if (chartStats) chartStats.destroy();
    const ctx = document.getElementById("chartStats").getContext("2d");
    chartStats = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Note /5",
            data: notes,
            borderColor: "#c9a84c",
            backgroundColor: "rgba(201,168,76,0.1)",
            yAxisID: 'y',
            tension: 0.4,
            pointRadius: 4
          },
          {
            label: "Score",
            data: scores,
            borderColor: "#4ab5e3",
            backgroundColor: "rgba(74,181,227,0.1)",
            yAxisID: 'y1',
            tension: 0.4,
            pointRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#c9d6e3' } } },
        scales: {
          x: { ticks: { color: '#8aa0b5' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { position: 'left', min: 0, max: 5, ticks: { color: '#c9a84c' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y1: { position: 'right', ticks: { color: '#4ab5e3' }, grid: { display: false } }
        }
      }
    });

    // Historique tableau
    const reversed = [...data].reverse().slice(0, 10);
    document.getElementById("historiqueTable").innerHTML = reversed.map(d => {
      const dateStr = d.date && d.date.toDate ? d.date.toDate().toLocaleDateString('fr-FR') : '—';
      const scoreClass = d.score >= 80 ? 'good' : d.score >= 50 ? 'mid' : 'bad';
      return `<tr>
        <td>${dateStr}</td>
        <td>${d.clients || 0}</td>
        <td>${d.note || '—'}</td>
        <td>${d.attente || 0} min</td>
        <td>${d.tempMoules ? d.tempMoules + '°C' : '—'}</td>
        <td>${d.caReel ? d.caReel + '€' : '—'}</td>
        <td><span class="badge-score ${scoreClass}">${d.score || 0}</span></td>
      </tr>`;
    }).join("");

  } catch(e) {
    console.error(e);
    showToast("Erreur chargement dashboard", "error");
  }
}

// ============================================================
// ============================================================
// MODULE 2 : AVIS GOOGLE
// ============================================================
// ============================================================

let modeAvis = 'texte'; // 'texte' ou 'rapide'

function setModeAvis(mode) {
  modeAvis = mode;
  document.getElementById('avis-mode-texte').classList.toggle('active', mode === 'texte');
  document.getElementById('avis-mode-rapide').classList.toggle('active', mode === 'rapide');
  document.getElementById('zone-texte').style.display = mode === 'texte' ? 'block' : 'none';
  document.getElementById('zone-rapide').style.display = mode === 'rapide' ? 'block' : 'none';
}

// Étoiles interactives
let noteAvisSelec = 0;
function setNoteAvis(n) {
  noteAvisSelec = n;
  document.querySelectorAll('.star-btn').forEach((s, i) => {
    s.classList.toggle('active', i < n);
  });
}

async function soumettreAvis() {
  const btn = document.getElementById("btnAvis");
  btn.textContent = "Analyse IA...";
  btn.disabled = true;

  let noteGoogle, texteAvis, motsCles;

  if (modeAvis === 'texte') {
    texteAvis = document.getElementById("texteAvis").value.trim();
    noteGoogle = +document.getElementById("noteGoogleTexte").value || 0;
    if (!texteAvis || !noteGoogle) {
      showToast("Remplis le texte et la note !", "error");
      btn.textContent = "Analyser et enregistrer";
      btn.disabled = false;
      return;
    }
  } else {
    noteGoogle = noteAvisSelec;
    motsCles = document.getElementById("motsClesRapide").value.trim();
    texteAvis = `[Saisie rapide] ${motsCles}`;
    if (!noteGoogle) {
      showToast("Sélectionne une note !", "error");
      btn.textContent = "Analyser et enregistrer";
      btn.disabled = false;
      return;
    }
  }

  // Analyse IA via Claude
  let analyse = { sentiment: 'neutre', resume: '', reponse: '', motsCles: [] };
  try {
    analyse = await analyserAvisIA(texteAvis, noteGoogle);
  } catch(e) {
    console.error("Erreur IA:", e);
    analyse.resume = "Analyse IA indisponible";
    analyse.sentiment = noteGoogle >= 4 ? 'positif' : noteGoogle <= 2 ? 'negatif' : 'neutre';
  }

  const avisData = {
    date: new Date(),
    note: noteGoogle,
    texte: texteAvis,
    sentiment: analyse.sentiment,
    resume: analyse.resume,
    reponseSuggeree: analyse.reponse,
    motsCles: analyse.motsCles,
    mode: modeAvis
  };

  try {
    await db.collection("avis").add(avisData);
    afficherAnalyseAvis(avisData);
    showToast("✅ Avis enregistré !");
    chargerAvis();
    // Reset
    document.getElementById("texteAvis").value = '';
    document.getElementById("noteGoogleTexte").value = '';
    document.getElementById("motsClesRapide").value = '';
    noteAvisSelec = 0;
    setNoteAvis(0);
  } catch(e) {
    showToast("❌ Erreur d'enregistrement", "error");
  }

  btn.textContent = "Analyser et enregistrer";
  btn.disabled = false;
}

// ============================================================
// ANALYSE IA (Claude API)
// ============================================================
async function analyserAvisIA(texte, note) {
  const GROQ_KEY = "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";

  const prompt = `Tu es un expert en restauration. Analyse cet avis Google d un restaurant de moules-frites (Moule & Smile, Saint-Pierre-la-Mer).
Avis (note ${note}/5) : "${texte}"
Reponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ou apres :
{"sentiment":"positif","resume":"resume en 1 phrase max 20 mots","motsCles":["mot1","mot2","mot3"],"reponse":"Reponse courtoise 2-3 phrases en francais"}`;

  console.log("🤖 Appel Groq...");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }]
    })
  });

  console.log("📡 Statut Groq:", response.status, response.statusText);

  if (!response.ok) {
    const errText = await response.text();
    console.error("❌ Erreur Groq HTTP:", errText);
    throw new Error("Groq HTTP " + response.status);
  }

  const data = await response.json();
  console.log("📦 Réponse Groq brute:", JSON.stringify(data).substring(0, 300));

  const rawText = data.choices[0].message.content.trim();
  console.log("📝 Texte Groq:", rawText.substring(0, 200));

  const clean = rawText.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  const s = (parsed.sentiment || "").toLowerCase();
  parsed.sentiment = s.includes("pos") ? "positif" : s.includes("neg") ? "negatif" : "neutre";

  console.log("✅ Analyse Groq OK:", parsed.sentiment);
  return parsed;
}

// ============================================================
// AFFICHAGE ANALYSE AVIS
// ============================================================
function afficherAnalyseAvis(d) {
  const sentimentColor = { positif: '#2ecc71', neutre: '#f39c12', negatif: '#e74c3c' };
  const sentimentLabel = { positif: '😊 Positif', neutre: '😐 Neutre', negatif: '😞 Négatif' };

  document.getElementById("avisResultat").innerHTML = `
    <div class="avis-result-card">
      <div class="avis-sentiment" style="background:${sentimentColor[d.sentiment]}20; border-left: 4px solid ${sentimentColor[d.sentiment]}">
        <strong>${sentimentLabel[d.sentiment]}</strong>
        <p>${d.resume}</p>
      </div>
      <div class="avis-mots">
        ${d.motsCles.map(m => `<span class="mot-cle">${m}</span>`).join("")}
      </div>
      <div class="avis-reponse">
        <h4>💬 Réponse suggérée</h4>
        <p>${d.reponseSuggeree}</p>
        <button onclick="copierReponse(this)" data-texte="${encodeURIComponent(d.reponseSuggeree)}" class="btn-copy">📋 Copier</button>
      </div>
    </div>
  `;
  document.getElementById("avisResultat").style.display = "block";
}

function copierReponse(btn) {
  const texte = decodeURIComponent(btn.getAttribute('data-texte'));
  navigator.clipboard.writeText(texte).then(() => {
    btn.textContent = "✅ Copié !";
    setTimeout(() => btn.textContent = "📋 Copier", 2000);
  });
}

// ============================================================
// CHARGER AVIS + GRAPHIQUE + MOTS-CLÉS
// ============================================================
async function chargerAvis() {
  try {
    const snapshot = await db.collection("avis").orderBy("date", "asc").get();
    const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (data.length === 0) {
      document.getElementById("avisHistorique").innerHTML = '<p class="empty-state">Aucun avis encore saisi.</p>';
      return;
    }

    // Stats globales
    const noteMoy = (data.reduce((s, d) => s + (d.note || 0), 0) / data.length).toFixed(2);
    const positifs = data.filter(d => d.sentiment === 'positif').length;
    const negatifs = data.filter(d => d.sentiment === 'negatif').length;
    const neutres = data.filter(d => d.sentiment === 'neutre').length;

    document.getElementById("avis-kpi-note").textContent = noteMoy + " ★";
    document.getElementById("avis-kpi-total").textContent = data.length;
    document.getElementById("avis-kpi-positifs").textContent = positifs;
    document.getElementById("avis-kpi-negatifs").textContent = negatifs;

    // Graphique évolution note
    const labels = data.map((d, i) => {
      if (d.date && d.date.toDate) return d.date.toDate().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      return `A${i+1}`;
    });
    const notes = data.map(d => d.note || 0);

    if (chartAvis) chartAvis.destroy();
    const ctx = document.getElementById("chartAvis").getContext("2d");
    chartAvis = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Note Google",
          data: notes,
          borderColor: "#c9a84c",
          backgroundColor: "rgba(201,168,76,0.15)",
          tension: 0.4,
          fill: true,
          pointRadius: 5,
          pointBackgroundColor: notes.map(n => n >= 4 ? '#2ecc71' : n >= 3 ? '#f39c12' : '#e74c3c')
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#c9d6e3' } } },
        scales: {
          x: { ticks: { color: '#8aa0b5' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { min: 0, max: 5, ticks: { color: '#c9a84c' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });

    // Mots-clés récurrents
    const allMots = data.flatMap(d => d.motsCles || []);
    const freq = {};
    allMots.forEach(m => freq[m.toLowerCase()] = (freq[m.toLowerCase()] || 0) + 1);
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12);

    document.getElementById("nuageMots").innerHTML = sorted.map(([mot, n]) =>
      `<span class="mot-freq" style="font-size:${Math.min(0.8 + n * 0.2, 1.6)}rem; opacity:${Math.min(0.5 + n * 0.1, 1)}">${mot} <sup>${n}</sup></span>`
    ).join(" ");

    // Historique avis
    const reversed = [...data].reverse().slice(0, 15);
    document.getElementById("avisHistorique").innerHTML = reversed.map(d => {
      const dateStr = d.date && d.date.toDate ? d.date.toDate().toLocaleDateString('fr-FR') : '—';
      const sc = { positif: 'good', neutre: 'mid', negatif: 'bad' }[d.sentiment] || 'mid';
      const stars = '★'.repeat(d.note || 0) + '☆'.repeat(5 - (d.note || 0));
      return `<div class="avis-hist-item">
        <div class="avis-hist-header">
          <span class="stars ${sc}">${stars}</span>
          <span class="avis-hist-date">${dateStr}</span>
          <span class="badge-score ${sc}">${d.sentiment}</span>
        </div>
        <p class="avis-resume">${d.resume || d.texte?.substring(0, 80) || '—'}</p>
      </div>`;
    }).join("");

  } catch(e) {
    console.error(e);
    showToast("Erreur chargement avis", "error");
  }
}

// ============================================================
// ============================================================
// PRÉVISIONS
// ============================================================

function initPrevisions() {
  // Initialiser avec aujourd'hui si pas encore de date
  const hidden = document.getElementById("prevDate");
  if (!hidden.value) {
    const today = new Date().toISOString().split('T')[0];
    hidden.value = today;
  }
  majAffichageDate();
  afficherPrevisionEnregistree();
  Reel.afficherEtat();
}

function changerDate(delta) {
  const hidden = document.getElementById("prevDate");
  const base = hidden.value ? new Date(hidden.value + "T12:00:00") : new Date();
  base.setDate(base.getDate() + delta);
  hidden.value = base.toISOString().split('T')[0];
  majAffichageDate();
  parametresChanges();
}

// Une prévision affichée est TOUJOURS celle des paramètres visibles : dès que la date,
// la saison, la météo ou l'événement change, on la recalcule (sinon « Enregistrer »
// enregistrerait l'ancienne). Le CA ajusté à la main est alors effacé.
let caManuelEnAttente = false;
function parametresChanges() {
  const champCA = document.getElementById("prevCAManuel");
  if (champCA) champCA.value = '';
  caManuelEnAttente = false;
  afficherPrevisionEnregistree();
  if (document.getElementById("prevResultat").style.display === "block") genererPrevisions();
}

// Bandeau « une prévision est déjà enregistrée pour ce jour »
async function afficherPrevisionEnregistree() {
  const el = document.getElementById("prevDejaEnregistree");
  const ds = document.getElementById("prevDate").value;
  if (!el || !ds) return;
  el.innerHTML = '';
  try {
    const doc = await db.collection("previsions").doc(ds).get();
    if (document.getElementById("prevDate").value !== ds) return; // la date a encore changé entre-temps
    if (doc.exists) {
      const p = doc.data();
      el.innerHTML = `<span style="color:var(--gold)">💾 Déjà enregistrée pour ce jour : <strong>${p.clientsMoy} couverts · ${formatEuro(p.caMoy || 0)}</strong>
        (le ${new Date(p.enregistreLe || 0).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${p.manuel ? ', CA ajusté à la main' : ''}).</span>
        <span style="color:var(--text-muted)">Une nouvelle prévision enregistrée la remplacera.</span>`;
    }
  } catch (e) { /* hors ligne : pas de bandeau */ }
}

function majAffichageDate() {
  const hidden = document.getElementById("prevDate");
  if (!hidden.value) return;
  const d = new Date(hidden.value + "T12:00:00");
  const jours = ["Dimanche","Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi"];
  const mois  = ["jan","fév","mar","avr","mai","juin","juil","août","sep","oct","nov","déc"];
  const affich = `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
  document.getElementById("prevDateAffichage").textContent = affich + (ouvertLe(d) ? '' : ' · fermé');
  // Saison choisie automatiquement selon le calendrier Moule & Smile (modifiable à la main)
  const sel = document.getElementById("prevSaison");
  if (sel) sel.value = saisonPour(d);
}

// Formater un montant en euros avec 2 décimales
function formatEuro(val) {
  return val.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

// Variables prévisions globales pour recalcul à la volée
let prevState = {};

async function genererPrevisions() {
  const dateStr = document.getElementById("prevDate").value;
  const saison  = document.getElementById("prevSaison").value;
  const meteo   = document.getElementById("prevMeteo").value;
  const event   = document.getElementById("prevEvent").value;

  if (!dateStr) { showToast("Sélectionne une date !", "error"); return; }

  const btn = document.querySelector("#tab-previsions .btn-primary");
  btn.textContent = "Calcul en cours..."; btn.disabled = true;

  const date = new Date(dateStr + "T12:00:00");
  const jourSemaine = date.getDay();
  const moisDate = date.getMonth(); // 0=jan ... 11=dec

  // ---- COEFFICIENTS FIXES (fallback) ----
  const coeffJour = { 0:1.10, 1:0.38, 2:0.42, 3:0.48, 4:0.65, 5:0.85, 6:1.00 }[jourSemaine] || 0.6;
  const coeffSaison = { haute:1.50, moyenne:0.75, basse:0.55 }[saison];
  const coeffMeteo  = { mauvais:1.20, nuageux:1.00, beau:0.82 }[meteo];
  const coeffEvent  = { non:1.00, marche:1.28, concert:1.40 }[event];
  const baseClients = 200;
  const pm = panierMoyenGlobal || 20;
  // Météo et événement sont appliqués UNE seule fois, plus bas (avant : appliqués deux fois)
  const clientsCoeffs = Math.round(baseClients * coeffJour * coeffSaison);

  // ---- LECTURE DONNÉES RÉELLES FIRESTORE ----
  let clientsMoy = clientsCoeffs;
  let sourceLabel = "📐 Estimation (pas encore de données réelles)";
  let fiabilite = 0;

  let pmUtilise = pm;
  let courbe = null;
  let infoPanier = '';
  try {
    // 1) Journées réelles de l'appli de commande (couverts) — synchro si la liaison est active
    if (Reel.user) await Reel.synchroniser(false); else await Reel.chargerJournees();
    const reels = journeesComparables(jourSemaine, saison).map(j => ({ dateStr: j.dateStr, clients: j.couverts }));

    // 2) Journées saisies à la main (onglet Saisie Journée), pour les dates sans donnée de l'appli
    const snapshot = await db.collection("stats").get();
    const datesReelles = new Set(Reel.journees.map(j => j.dateStr));
    const saisies = snapshot.docs.map(d => d.data()).filter(d => {
      if (!d.date || !d.date.toDate || !(d.clients > 0)) return false;
      const dd = d.date.toDate();
      const ds = dd.toISOString().slice(0, 10);
      return dd.getDay() === jourSemaine && saisonPour(dd) === saison && !datesReelles.has(ds);
    }).map(d => ({ clients: d.clients }));

    const memSaison = reels.concat(saisies);
    const n = memSaison.length;
    fiabilite = n;
    const w = poidsReel(n);
    if (n > 0) {
      const moyReelle = memSaison.reduce((s, d) => s + d.clients, 0) / n;
      clientsMoy = Math.round(moyReelle * w + clientsCoeffs * (1 - w));
      const detail = reels.length ? `${reels.length} de l'appli de commande` + (saisies.length ? ` + ${saisies.length} saisie(s)` : '') : `${saisies.length} saisie(s)`;
      sourceLabel = n >= 15 ? `📊 Basé sur ${n} journées réelles (${detail}) — fiabilité élevée`
                  : n >= 5  ? `📈 Basé sur ${n} journées réelles (${detail}) + estimation — fiabilité moyenne`
                  :           `🔎 ${n} journée(s) réelle(s) (${detail}) — estimation majoritaire`;
    }

    // 3) Panier moyen réel par couvert (dès 5 journées comparables)
    const pr = panierReel(jourSemaine, saison);
    if (pr) {
      const wp = poidsReel(pr.nb);
      pmUtilise = Math.round((pr.valeur * wp + pm * (1 - wp)) * 100) / 100;
      infoPanier = ` · panier réel ${formatEuro(pr.valeur)} sur ${pr.nb} journées`;
    }

    // 4) Vraie courbe des arrivées par créneau de 30 min
    const cr = courbeReelle(jourSemaine, saison);
    if (cr) courbe = { ...cr, poids: poidsReel(cr.nbJours) };
  } catch(e) {
    console.error("Erreur lecture données réelles:", e);
  }
  // Effet de période appris (fin de mois, après le 15 août…) — inactif tant qu'il manque des journées
  try {
    const ep = effetPeriode(date, saison);
    if (ep.actif && Math.abs(ep.facteur - 1) >= 0.005) {
      clientsMoy = Math.round(clientsMoy * ep.facteur);
      const pct = Math.round((ep.brut - 1) * 100);
      sourceLabel += ` · 📆 ${ep.libelle} : ${pct > 0 ? '+' : ''}${pct} % mesuré sur ${ep.n} journées, appliqué à ${Math.round(ep.poids * 100)} %`;
    } else if (!ep.actif) {
      sourceLabel += ` · 📆 effet « ${ep.libelle} » pas encore actif (${ep.n}/${MIN_JOURNEES_EFFET_PERIODE} journées)`;
    }
  } catch (e) { console.error("Effet période :", e); }
  if (!ouvertLe(date)) sourceLabel = "⚠️ Jour normalement FERMÉ selon le calendrier · " + sourceLabel;
  sourceLabel += infoPanier;

  // Appliquer météo et événement sur la base pondérée
  clientsMoy = Math.round(clientsMoy * coeffMeteo * coeffEvent);
  const clientsMin = Math.round(clientsMoy * 0.78);
  const clientsMax = Math.round(clientsMoy * 1.28);

  prevState = { clientsMoy, clientsMin, clientsMax, pm: pmUtilise, jourSemaine, dateStr, sourceLabel, fiabilite, coeffJour, coeffSaison, coeffMeteo, coeffEvent, courbe };

  btn.textContent = "Générer les prévisions"; btn.disabled = false;
  afficherResultatsPrevisions(clientsMoy, clientsMin, clientsMax, pmUtilise, jourSemaine, sourceLabel, fiabilite, coeffJour, coeffSaison, coeffMeteo, coeffEvent);
}

function appliquerCAManuel() {
  const caManuel = parseFloat(document.getElementById("prevCAManuel").value);
  if (!caManuel || caManuel <= 0) { showToast("Saisis un CA valide !", "error"); return; }
  caManuelEnAttente = false;
  const pm = prevState.pm || panierMoyenGlobal || 20;
  const clientsMoy = Math.round(caManuel / pm);
  const clientsMin = Math.round(clientsMoy * 0.78);
  const clientsMax = Math.round(clientsMoy * 1.28);
  prevState = { ...prevState, clientsMoy, clientsMin, clientsMax, pm };
  const { coeffJour:cJ, coeffSaison:cS, coeffMeteo:cM, coeffEvent:cE } = prevState;
  afficherResultatsPrevisions(clientsMoy, clientsMin, clientsMax, pm, prevState.jourSemaine, '✏️ CA saisi manuellement', prevState.fiabilite, cJ||1, cS||1, cM||1, cE||1);
  showToast("✅ Planning recalculé sur " + formatEuro(caManuel));
}

function afficherResultatsPrevisions(clientsMoy, clientsMin, clientsMax, pm, jourSemaine, sourceLabel, fiabilite, coeffJour, coeffSaison, coeffMeteo, coeffEvent) {
  // Valeurs par défaut si appelé sans coefficients
  coeffJour   = coeffJour   || 1;
  coeffSaison = coeffSaison || 1;
  coeffMeteo  = coeffMeteo  || 1;
  coeffEvent  = coeffEvent  || 1;
  const caMin = clientsMin * pm;
  const caMoy = clientsMoy * pm;
  const caMax = clientsMax * pm;

  document.getElementById("prev-ca-min").textContent = formatEuro(caMin);
  document.getElementById("prev-ca-moy").textContent = formatEuro(caMoy);
  document.getElementById("prev-ca-max").textContent = formatEuro(caMax);

  const joursLabel = ["Dim","Lun","Mar","Mer","Jeu","Ven","Sam"][jourSemaine];
  document.getElementById("prev-clients-info").innerHTML =
    `${joursLabel} · ${clientsMin}–${clientsMax} clients estimés · Panier moyen ${pm} €<br>
    <span style="font-size:0.75rem;margin-top:4px;display:inline-block;color:var(--aqua-light);">${sourceLabel || ''}</span>`;

  // ---- CRÉNEAUX HORAIRES (courbe estimée, avant journées réelles) ----
  // Moule & Smile sert les moules à volonté en continu de 11h30 à 23h : pas de mode
  // « snacking » l'après-midi, tous les créneaux sont calculés de la même façon
  // (repas 1h30, même panier, mêmes règles de personnel).
  // Poids bruts ci-dessous, ramenés à 100 % juste après : midi ≈ 33 %, après-midi ≈ 11 %, soir ≈ 56 %.
  // Dès qu'il y a des journées réelles, la vraie courbe prend le relais (voir plus bas).
  const creneaux = [
    { heure: "11h30", label: "Ouverture midi",  pct: 0.030 },
    { heure: "12h00", label: "Montée midi",     pct: 0.070 },
    { heure: "12h30", label: "🍽️ Peak midi",   pct: 0.110 },
    { heure: "13h00", label: "🍽️ Peak midi",   pct: 0.100 },
    { heure: "13h30", label: "Descente midi",   pct: 0.060 },
    { heure: "14h00", label: "Fin midi",        pct: 0.030 },
    { heure: "14h30", label: "Après-midi",      pct: 0.020 },
    { heure: "15h00", label: "Après-midi",      pct: 0.022 },
    { heure: "15h30", label: "Après-midi",      pct: 0.025 },
    { heure: "16h00", label: "Après-midi",      pct: 0.025 },
    { heure: "16h30", label: "Après-midi",      pct: 0.022 },
    { heure: "17h00", label: "Après-midi",      pct: 0.020 },
    { heure: "17h30", label: "Reprise soir",    pct: 0.028 },
    { heure: "18h00", label: "Montée soir",     pct: 0.034 },
    { heure: "18h30", label: "Montée soir",     pct: 0.050 },
    { heure: "19h00", label: "Montée soir",     pct: 0.067 },
    { heure: "19h30", label: "Montée soir",     pct: 0.084 },
    { heure: "20h00", label: "Pré-peak soir",   pct: 0.084 },
    { heure: "20h30", label: "🔥 Peak soir",    pct: 0.101 },
    { heure: "21h00", label: "🔥 Peak soir",    pct: 0.101 },
    { heure: "21h30", label: "🔥 Peak soir",    pct: 0.073 },
    { heure: "22h00", label: "Fin de service",  pct: 0.039 },
    { heure: "22h30", label: "Fin de service",  pct: 0.017 },
    { heure: "23h00", label: "Fermeture",       pct: 0.006 }
  ];
  const sommePct = creneaux.reduce((s, c) => s + c.pct, 0);
  creneaux.forEach(c => { c.pct = c.pct / sommePct; });

  // ---- PANIER MOYEN PAR MODE DE SERVICE ----
  const pmResto   = pm;          // moules : panier moyen réglages (ex: 24-28€)
  const pmSnack   = pm * 0.55;   // snacking : ~55% du panier resto (fish/nuggets/boissons)

  // ---- BASE SNACKING INDÉPENDANTE ----
  // Haute saison peak = 60 clients/h = 30 par créneau 30 min
  // Coefficients saison/jour appliqués aussi sur le snack
  const baseSnack = 30; // clients par 30 min au peak snack haute saison
  // Distribution snack sur la journée (pct relatif au peak snack)
  const pctSnackMap = {
    "14h30": 0.55, "15h00": 0.75, "15h30": 1.00,
    "16h00": 1.00, "16h30": 0.75, "17h00": 0.45
  };

  // ---- PRÉ-CALCUL ARRIVÉES PAR CRÉNEAU ----
  let arrivees = creneaux.map(c => {
    if (c.snack) {
      // Snacking : base indépendante avec mêmes coefficients saison/jour/météo/event
      const snackPeak = Math.round(baseSnack * coeffJour * coeffSaison * coeffMeteo * coeffEvent);
      return Math.round(snackPeak * (pctSnackMap[c.heure] || 0.5));
    }
    return Math.round(clientsMoy * c.pct);
  });

  // ---- VRAIE COURBE (journées réelles de l'appli de commande) ----
  // Mélange courbe réelle / courbe estimée avec le même poids que pour le nombre de clients
  // (1-4 journées : 20 % réel · 5-14 : 50 % · 15 et plus : 80 %).
  const courbe = prevState.courbe;
  let infoCourbe = "📐 Courbe horaire estimée (pas encore de journées réelles)";
  if (courbe && courbe.poids > 0) {
    const w = courbe.poids;
    const totalEstime = arrivees.reduce((s, n) => s + n, 0);
    arrivees = creneaux.map((c, i) => {
      const h = parseInt(c.heure, 10) + (c.heure.endsWith('30') ? 0.5 : 0);
      const reel = clientsMoy * (courbe.parts[h.toFixed(1)] || 0);
      return Math.round(reel * w + arrivees[i] * (1 - w));
    });
    infoCourbe = `📊 Courbe horaire : ${Math.round(w * 100)} % réelle (${courbe.nbJours} journée${courbe.nbJours > 1 ? 's' : ''}, ${courbe.source})`;
  }
  const totalArrivees      = arrivees.reduce((s, n) => s + n, 0);
  const totalArriveesResto = creneaux.reduce((s, c, i) => s + (!c.snack ? arrivees[i] : 0), 0);
  const totalArriveesSnack = creneaux.reduce((s, c, i) => s + ( c.snack ? arrivees[i] : 0), 0);

  // ---- CALCUL CLIENTS EN SALLE ----
  // Resto : durée repas 1h30 = 3 créneaux
  // Snacking : durée 20 min = 1 créneau (rotation rapide)
  const enSalle = arrivees.map((_, i) => {
    const duree = creneaux[i].snack ? 1 : 3;
    let cumul = 0;
    for (let j = Math.max(0, i - duree + 1); j <= i; j++) cumul += arrivees[j];
    return cumul;
  });
  const maxEnSalle = Math.max(...enSalle);

  // ---- CALCUL CA PAR CRÉNEAU ----
  const caParCreneau = creneaux.map((c, i) => arrivees[i] * (c.snack ? pmSnack : pmResto));
  const caTotalResto = creneaux.reduce((s, c, i) => s + (!c.snack ? caParCreneau[i] : 0), 0);
  const caTotalSnack = creneaux.reduce((s, c, i) => s + ( c.snack ? caParCreneau[i] : 0), 0);

  // ---- CALCUL STAFF ----
  function calcStaff(nSalle, isSnack) {
    return appliquerEffectifMin(calcStaffBrut(nSalle, isSnack));
  }
  function appliquerEffectifMin(st) {
    const min = effectifMinGlobal || 0;
    if (min <= 0 || st.total >= min) return st;
    const r = { ...st };
    const ordre = ['marmites', 'friteuses', 'salle'];
    ordre.forEach(k => { if (r.total < min && r[k] < 1) { r[k] = 1; r.total++; } });
    let alt = 0;
    while (r.total < min) { const k = alt++ % 2 ? 'bar' : 'salle'; r[k]++; r.total++; }
    r.minimum = true;
    return r;
  }
  function calcStaffBrut(nSalle, isSnack) {
    if (isSnack) {
      // Mode snacking : staff minimum 3 quelle que soit l'affluence
      const friteuses   = 1; // toujours 1 friteuse
      const salleSnack  = nSalle >= 20 ? 2 : 1;
      const bar         = 1; // toujours 1 bar
      return { marmites:0, friteuses, remplissage:0, salle:salleSnack, bar,
               total: friteuses + salleSnack + bar };
    }
    // Mode restaurant
    const marmites    = nSalle >= 60 ? 2 : nSalle >= 25 ? 1 : 0;
    const friteuses   = nSalle >= 60 ? 2 : nSalle >= 25 ? 1 : 0;
    const remplissage = nSalle >= 40 ? 1 : 0;
    const salle       = nSalle >= 60 ? 3 : nSalle >= 30 ? 2 : nSalle >= 10 ? 1 : 1;
    const bar         = nSalle >= 50 ? 2 : nSalle >= 20 ? 1 : 0;
    return { marmites, friteuses, remplissage, salle, bar,
             total: marmites + friteuses + remplissage + salle + bar };
  }

  const rows = creneaux.map((c, i) => {
    const arrive   = arrivees[i];
    const salle    = enSalle[i];
    const ca       = caParCreneau[i];
    const staff    = calcStaff(salle, c.snack);
    const isPeak   = c.label.includes("🔥") || c.label.includes("🍽️");
    const isCreux  = c.label === "Creux";
    const rowClass = c.snack ? 'snack-row' : isPeak ? 'peak-row' : isCreux ? 'creux-row' : '';
    const pctSalle = maxEnSalle > 0 ? Math.round((salle / maxEnSalle) * 100) : 0;
    const barColor = pctSalle >= 85 ? 'var(--danger)' : pctSalle >= 60 ? 'var(--warning)' : 'var(--success)';
    const modeTag  = ''; // service continu : plus de distinction resto / snacking

    return `<tr class="${rowClass}">
      <td><strong>${c.heure}</strong></td>
      <td>${c.label} ${modeTag}</td>
      <td style="color:var(--gold);font-weight:600;text-align:center;">${arrive}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:${pctSalle*0.5}px;height:6px;background:${barColor};border-radius:3px;min-width:2px;max-width:50px;"></div>
          <span style="color:var(--aqua-light);font-weight:600;">${salle}</span>
        </div>
      </td>
      <td style="color:var(--aqua);font-size:0.8rem;">${formatEuro(ca)}</td>
      <td>
        <div class="staff-badges">
          ${staff.marmites    > 0 ? `<span class="sbadge">🍲×${staff.marmites}</span>`  : ''}
          ${staff.friteuses   > 0 ? `<span class="sbadge">🍟×${staff.friteuses}</span>` : ''}
          ${staff.remplissage > 0 ? `<span class="sbadge">🔄×1</span>`                  : ''}
          <span class="sbadge">🧑‍🍳×${staff.salle}</span>
          ${staff.bar > 0 ? `<span class="sbadge">🍺×${staff.bar}</span>` : ''}
          <span class="sbadge total-badge">= ${staff.total}</span>
        </div>
      </td>
    </tr>`;
  }).join("");

  document.getElementById("planningTable").innerHTML = `
    <p style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:8px;">${infoCourbe}</p>
    <div class="table-wrap">
    <table style="min-width:640px;">
      <thead><tr>
        <th>Heure</th>
        <th>Créneau</th>
        <th style="text-align:center;">🚪 Arrivées</th>
        <th>🪑 En salle</th>
        <th>CA (30 min)</th>
        <th>Staff nécessaire</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="border-top:2px solid var(--ocean-border);">
          <td colspan="2" style="padding-top:12px;">
            <div style="display:flex;flex-direction:column;gap:4px;">
              <span class="mode-resto" style="font-size:0.72rem;">🦪 Service continu 11h30 → 23h · durée repas 1h30</span>
              <span style="font-size:0.72rem;color:var(--text-muted);">Effectif minimum : ${effectifMinGlobal || 0} personne${(effectifMinGlobal || 0) > 1 ? 's' : ''}</span>
            </div>
          </td>
          <td style="text-align:center;padding-top:12px;">
            <div style="display:flex;flex-direction:column;gap:4px;align-items:center;">
              <span class="sbadge total-badge">= ${totalArrivees}</span>
              <span style="font-size:0.68rem;color:var(--text-muted);">arrivées de la journée</span>
            </div>
          </td>
          <td style="padding-top:12px;">
            <span style="font-size:0.75rem;color:var(--text-muted);">max : ${maxEnSalle}</span>
          </td>
          <td style="padding-top:12px;">
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-size:0.72rem;color:var(--gold);">${formatEuro(caTotalResto + caTotalSnack)}</span>
            </div>
          </td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>
    </div>`;

  const ctxEl = document.getElementById("prevContexte");
  if (ctxEl) {
    const lib = s => { const o = document.getElementById(s); return o && o.selectedOptions[0] ? o.selectedOptions[0].textContent.trim() : ''; };
    ctxEl.textContent = `${libelleJour(prevState.dateStr, true)} · ${lib("prevMeteo")} · ${lib("prevEvent") === 'Aucun' ? 'pas d\'événement' : lib("prevEvent")}${String(sourceLabel || '').startsWith('✏️') ? ' · CA ajusté à la main' : ''}`;
  }
  // Mémorise la prévision affichée pour le bouton « Enregistrer »
  const staffParCreneau = enSalle.map((n, i) => calcStaff(n, creneaux[i].snack));
  dernierResultat = {
    dateStr: prevState.dateStr,
    jourSemaine,
    saison: document.getElementById("prevSaison").value,
    meteo: document.getElementById("prevMeteo").value,
    event: document.getElementById("prevEvent").value,
    clientsMin, clientsMoy, clientsMax,
    caMin: Math.round(caMin * 100) / 100, caMoy: Math.round(caMoy * 100) / 100, caMax: Math.round(caMax * 100) / 100,
    pm,
    sourceLabel: sourceLabel || '',
    manuel: String(sourceLabel || '').startsWith('✏️'),
    fiabilite: fiabilite || 0,
    staffMax: Math.max(...staffParCreneau.map(s => s.total)),
    totalArrivees,
    creneaux: creneaux.map((c, i) => ({
      heure: c.heure, label: c.label, snack: !!c.snack,
      arrivees: arrivees[i], enSalle: enSalle[i],
      ca: Math.round(caParCreneau[i] * 100) / 100,
      staff: staffParCreneau[i]
    }))
  };

  document.getElementById("prevResultat").style.display = "block";
  document.getElementById("prevResultat").scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
// IMPORT CSV SUMUP
// ============================================================

let importData = []; // données parsées en attente de sauvegarde
let chartImport = null;

function initImport() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById("importDate").value = today;

  // Drag & drop
  const zone = document.getElementById("dropZone");
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.style.borderColor = 'var(--gold)'; });
  zone.addEventListener("dragleave", () => { zone.style.borderColor = 'var(--ocean-border)'; });
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.style.borderColor = 'var(--ocean-border)';
    const file = e.dataTransfer.files[0];
    if (file) lireCSV(file);
  });
}

function lireCSV(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const texte = e.target.result;
      const tickets = parserCSVSumUp(texte);
      if (tickets.length === 0) {
        showToast("Aucune donnée valide trouvée dans le CSV", "error");
        return;
      }
      importData = tickets;
      afficherImport(tickets);
      showToast(`✅ ${tickets.length} tickets chargés !`);
    } catch(err) {
      console.error("Erreur parsing CSV:", err);
      showToast("❌ Format CSV non reconnu", "error");
    }
  };
  reader.readAsText(file, 'UTF-8');
}

// Parser le format SumUp Pro export commandes
// Colonnes : #, Date d'ouverture, Heure d'ouverture, Durée, Utilisateur, Table, Statut, Total, Statut paiement
function parserCSVSumUp(texte) {
  const lignes = texte.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lignes.length < 2) return [];

  // Détecter le séparateur (virgule ou point-virgule)
  const sep = lignes[0].includes(';') ? ';' : ',';

  const headers = lignes[0].split(sep).map(h => h.replace(/"/g, '').toLowerCase().trim());
  console.log("Headers CSV:", headers);

  // Trouver les colonnes
  const iHeure = headers.findIndex(h => h.includes("heure") && h.includes("ouverture") || h === "time" || h.includes("heure"));
  const iTotal = headers.findIndex(h => h === "total" || h.includes("montant") || h.includes("ca ttc") || h.includes("amount"));
  const iStatut = headers.findIndex(h => h.includes("statut") && h.includes("pay") || h === "payment status");
  const iDate = headers.findIndex(h => h.includes("date"));

  const tickets = [];
  for (let i = 1; i < lignes.length; i++) {
    const cols = lignes[i].split(sep).map(c => c.replace(/"/g, '').trim());
    if (cols.length < 3) continue;

    // Heure
    const heureStr = iHeure >= 0 ? cols[iHeure] : cols[2];
    const heure = extraireHeure(heureStr);
    if (heure === null) continue;

    // Total
    const totalStr = iTotal >= 0 ? cols[iTotal] : cols[cols.length - 2];
    const total = parseFloat(totalStr.replace(',', '.').replace(/[^0-9.]/g, ''));
    if (isNaN(total) || total <= 0) continue;

    // Statut (garder seulement les tickets fermés/payés)
    const statut = iStatut >= 0 ? cols[iStatut].toLowerCase() : '';
    if (statut && (statut.includes('annul') || statut.includes('cancel'))) continue;

    tickets.push({ heure, total });
  }
  return tickets;
}

function extraireHeure(str) {
  if (!str) return null;
  const match = str.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1]) + parseInt(match[2]) / 60;
}

// Générer données fictives réalistes SumUp pour tester
function chargerDonneeTest() {
  const ticketsFictifs = [];
  // Distribution réaliste d'une journée samedi haute saison (~200 tickets)
  const distribution = [
    { h: 11.5, n: 4 },  { h: 12, n: 12 }, { h: 12.5, n: 18 }, { h: 13, n: 16 },
    { h: 13.5, n: 10 }, { h: 14, n: 6 },  { h: 14.5, n: 3 },  { h: 15, n: 2 },
    { h: 15.5, n: 2 },  { h: 16, n: 2 },  { h: 16.5, n: 2 },  { h: 17, n: 3 },
    { h: 17.5, n: 4 },  { h: 18, n: 6 },  { h: 18.5, n: 8 },  { h: 19, n: 10 },
    { h: 19.5, n: 12 }, { h: 20, n: 14 }, { h: 20.5, n: 18 }, { h: 21, n: 20 },
    { h: 21.5, n: 16 }, { h: 22, n: 12 }, { h: 22.5, n: 8 },  { h: 23, n: 3 }
  ];
  // Paniers réalistes : 24.90, 28.90, 35.80 (2 formules), extras boissons
  const paniers = [24.90, 28.90, 28.90, 35.80, 53.80, 49.80, 24.90, 28.90, 57.80, 35.80];
  distribution.forEach(({ h, n }) => {
    for (let i = 0; i < n; i++) {
      const panier = paniers[Math.floor(Math.random() * paniers.length)];
      ticketsFictifs.push({ heure: h + Math.random() * 0.45, total: panier });
    }
  });
  importData = ticketsFictifs;
  afficherImport(ticketsFictifs);
  showToast(`🧪 ${ticketsFictifs.length} tickets fictifs chargés !`);
}

function afficherImport(tickets) {
  const totalCA = tickets.reduce((s, t) => s + t.total, 0);
  const panierMoy = totalCA / tickets.length;

  // KPIs
  document.getElementById("imp-tickets").textContent = tickets.length;
  document.getElementById("imp-ca").textContent = formatEuro(totalCA);
  document.getElementById("imp-moy").textContent = formatEuro(panierMoy);

  // Regrouper par créneau de 30 min
  const creneaux = {};
  for (let h = 11; h <= 23; h++) {
    creneaux[h + '.0'] = { label: `${h}h00`, tickets: 0, ca: 0 };
    creneaux[h + '.5'] = { label: `${h}h30`, tickets: 0, ca: 0 };
  }

  tickets.forEach(t => {
    const demi = t.heure >= 0 ? (Math.floor(t.heure * 2) / 2).toFixed(1) : null;
    if (demi && creneaux[demi]) {
      creneaux[demi].tickets++;
      creneaux[demi].ca += t.total;
    }
  });

  // Filtrer les créneaux vides en début/fin
  const cles = Object.keys(creneaux).filter(k => creneaux[k].tickets > 0 ||
    (parseFloat(k) >= 11.5 && parseFloat(k) <= 23.0));

  // Date
  const dateInput = document.getElementById("importDate").value;
  document.getElementById("imp-date").textContent = dateInput ?
    new Date(dateInput + "T12:00:00").toLocaleDateString('fr-FR') : "—";

  // Graphique
  const labelsChart = cles.map(k => creneaux[k].label);
  const dataTickets = cles.map(k => creneaux[k].tickets);
  const dataCA = cles.map(k => Math.round(creneaux[k].ca));

  if (chartImport) chartImport.destroy();
  const ctx = document.getElementById("chartImport").getContext("2d");
  chartImport = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labelsChart,
      datasets: [
        {
          label: 'Tickets',
          data: dataTickets,
          backgroundColor: 'rgba(201,168,76,0.7)',
          yAxisID: 'y'
        },
        {
          label: 'CA (€)',
          data: dataCA,
          type: 'line',
          borderColor: '#4ab5e3',
          backgroundColor: 'transparent',
          tension: 0.4,
          yAxisID: 'y1',
          pointRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#c9d6e3', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#8aa0b5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y:  { position: 'left',  ticks: { color: '#c9a84c' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y1: { position: 'right', ticks: { color: '#4ab5e3' }, grid: { display: false } }
      }
    }
  });

  // ---- CALCUL EN SALLE (durée repas 1h30 = 3 créneaux) ----
  const DUREE_REPAS_IMP = 3;
  const arriveesList = cles.map(k => creneaux[k].tickets);
  const enSalleList  = arriveesList.map((_, i) => {
    let cumul = 0;
    for (let j = Math.max(0, i - DUREE_REPAS_IMP + 1); j <= i; j++) cumul += arriveesList[j];
    return cumul;
  });
  const maxEnSalleImp = Math.max(...enSalleList);
  const totalArriveesImp = arriveesList.reduce((s, n) => s + n, 0);
  const pm = panierMoyenGlobal || 20;

  // ---- CALCUL STAFF ----
  function calcStaffImp(nSalle) {
    const marmites    = nSalle >= 60 ? 2 : nSalle >= 25 ? 1 : 0;
    const friteuses   = nSalle >= 60 ? 2 : nSalle >= 25 ? 1 : 0;
    const remplissage = nSalle >= 40 ? 1 : 0;
    const salle       = nSalle >= 60 ? 3 : nSalle >= 30 ? 2 : nSalle >= 10 ? 1 : 1;
    const bar         = nSalle >= 50 ? 2 : nSalle >= 20 ? 1 : 0;
    return { marmites, friteuses, remplissage, salle, bar,
             total: marmites + friteuses + remplissage + salle + bar };
  }

  // Tableau détail
  const rows = cles.map((k, i) => {
    const c       = creneaux[k];
    const arrive  = arriveesList[i];
    const salle   = enSalleList[i];
    const staff   = calcStaffImp(salle);
    const pct     = tickets.length > 0 ? ((arrive / tickets.length) * 100).toFixed(1) : 0;
    const pctSalle = maxEnSalleImp > 0 ? Math.round((salle / maxEnSalleImp) * 100) : 0;
    const barColor = pctSalle >= 85 ? 'var(--danger)' : pctSalle >= 60 ? 'var(--warning)' : 'var(--success)';
    const isPeak  = arrive >= Math.max(...arriveesList) * 0.7;

    return `<tr ${isPeak ? 'class="peak-row"' : ''}>
      <td><strong>${c.label}</strong></td>
      <td style="color:var(--gold);text-align:center;font-weight:600;">${arrive}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:${pctSalle * 0.5}px;height:6px;background:${barColor};border-radius:3px;min-width:2px;max-width:50px;"></div>
          <span style="color:var(--aqua-light);font-weight:600;">${salle}</span>
        </div>
      </td>
      <td style="color:var(--aqua);font-size:0.8rem;">${formatEuro(c.ca)}</td>
      <td style="font-size:0.75rem;color:var(--text-secondary)">${pct}%</td>
      <td>
        <div class="staff-badges">
          ${staff.marmites    > 0 ? `<span class="sbadge">🍲×${staff.marmites}</span>`  : ''}
          ${staff.friteuses   > 0 ? `<span class="sbadge">🍟×${staff.friteuses}</span>` : ''}
          ${staff.remplissage > 0 ? `<span class="sbadge">🔄×1</span>`                  : ''}
          <span class="sbadge">🧑‍🍳×${staff.salle}</span>
          ${staff.bar > 0 ? `<span class="sbadge">🍺×${staff.bar}</span>` : ''}
          <span class="sbadge total-badge">= ${staff.total}</span>
        </div>
      </td>
    </tr>`;
  }).join("");

  document.getElementById("importTable").innerHTML = `
    ${rows}
    <tr style="border-top:2px solid var(--ocean-border);">
      <td style="color:var(--text-secondary);font-size:0.75rem;padding-top:10px;">
        <em>Durée repas : 1h30</em>
      </td>
      <td style="text-align:center;padding-top:10px;">
        <span class="sbadge total-badge">${totalArriveesImp}</span>
      </td>
      <td style="padding-top:10px;">
        <span style="font-size:0.75rem;color:var(--text-muted);">max : ${maxEnSalleImp}</span>
      </td>
      <td colspan="3"></td>
    </tr>`;
  document.getElementById("importResultat").style.display = "block";
  document.getElementById("importResultat").scrollIntoView({ behavior: 'smooth' });
}

async function sauvegarderImport() {
  if (!importData.length) { showToast("Aucune donnée à sauvegarder", "error"); return; }

  const dateStr = document.getElementById("importDate").value;
  if (!dateStr) { showToast("Sélectionne une date !", "error"); return; }

  const btn = document.querySelector("#tab-import .btn-primary");
  btn.textContent = "Sauvegarde..."; btn.disabled = true;

  try {
    // Regrouper par créneau 30 min
    const creneaux = {};
    importData.forEach(t => {
      const demi = (Math.floor(t.heure * 2) / 2).toFixed(1);
      if (!creneaux[demi]) creneaux[demi] = { tickets: 0, ca: 0 };
      creneaux[demi].tickets++;
      creneaux[demi].ca += t.total;
    });

    const totalCA    = importData.reduce((s, t) => s + t.total, 0);
    const totalTick  = importData.length;
    const panierMoy  = totalCA / totalTick;
    const jourSemaine = new Date(dateStr + "T12:00:00").getDay();

    await db.collection("imports_caisse").add({
      date: new Date(dateStr + "T12:00:00"),
      dateStr,
      jourSemaine,
      totalCA,
      totalTickets: totalTick,
      panierMoyen: parseFloat(panierMoy.toFixed(2)),
      creneaux,
      source: "SumUp CSV"
    });

    showToast("✅ Données sauvegardées ! Les prévisions s'améliorent.");
    importData = [];

  } catch(e) {
    console.error("Erreur sauvegarde import:", e);
    showToast("❌ " + (e.message || "Erreur sauvegarde"), "error");
  }

  btn.textContent = "💾 Sauvegarder et alimenter les prévisions";
  btn.disabled = false;
}

// ============================================================
// RÉGLAGES
// ============================================================

async function chargerReglagesInit() {
  try {
    const doc = await db.collection("config").doc("reglages").get();
    if (doc.exists) {
      panierMoyenGlobal = doc.data().panierMoyen || 20;
      if (doc.data().effectifMin !== undefined) effectifMinGlobal = doc.data().effectifMin;
      console.log("Panier moyen chargé :", panierMoyenGlobal, "€");
    } else {
      console.log("Pas de réglages en base, panier moyen par défaut :", panierMoyenGlobal, "€");
    }
  } catch(e) {
    console.error("ERREUR CHARGEMENT RÉGLAGES:", e.code, e.message);
  }
}

async function chargerReglages() {
  const doc = await db.collection("config").doc("reglages").get().catch(() => null);
  const val = doc && doc.exists ? doc.data().panierMoyen : panierMoyenGlobal;
  document.getElementById("inputPanierMoyen").value = val;
  const em = document.getElementById("inputEffectifMin");
  if (em) em.value = doc && doc.exists && doc.data().effectifMin !== undefined ? doc.data().effectifMin : effectifMinGlobal;
  document.getElementById("affichagePanier").textContent = val + " €";
}

async function sauvegarderReglages() {
  const val = +document.getElementById("inputPanierMoyen").value;
  if (!val || val < 1) { showToast("Panier moyen invalide", "error"); return; }
  try {
    const emEl = document.getElementById("inputEffectifMin");
    const em = emEl && emEl.value !== '' ? Math.max(0, Math.round(+emEl.value)) : effectifMinGlobal;
    await db.collection("config").doc("reglages").set({ panierMoyen: val, effectifMin: em }, { merge: true });
    effectifMinGlobal = em;
    panierMoyenGlobal = val;
    document.getElementById("affichagePanier").textContent = val + " €";
    showToast("✅ Réglages sauvegardés !");
  } catch(e) {
    console.error("ERREUR SAUVEGARDE RÉGLAGES:", e.code, e.message);
    showToast("❌ " + (e.message || "Erreur sauvegarde"), "error");
  }
}

// NOTIFICATIONS
// ============================================================
function notifier(message) {
  if (Notification.permission === "granted") new Notification("🦪 Moule & Smile", { body: message });
}
if (Notification.permission !== "granted") Notification.requestPermission();

// SERVICE WORKER
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js");

// ============================================================
// PRÉVISIONS ENREGISTRÉES — par date et par semaine (17/10/2026)
// ------------------------------------------------------------
// Collection « previsions » : un document par date (AAAA-MM-JJ). Réenregistrer
// une date remplace l'ancienne prévision de cette date.
// L'onglet « 🗓️ Mes prévisions » affiche une semaine (lundi → dimanche) avec,
// pour chaque jour, le prévu, le réel (journées réelles de l'appli de commande)
// et l'écart. Un clic sur un jour ouvre le détail par créneau de 30 min.
// ============================================================
const PREVISIONS = "previsions";
let dernierResultat = null;   // dernière prévision affichée (prête à être enregistrée)
let semaineLundi = null;      // "AAAA-MM-JJ" du lundi affiché
let semainePrevisions = {};   // dateStr → prévision enregistrée
let semaineJourOuvert = null;

function dateStrLocale(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function lundiDe(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const decal = (d.getDay() + 6) % 7; // lundi = 0
  d.setDate(d.getDate() - decal);
  return dateStrLocale(d);
}
function libelleJour(dateStr, long) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString('fr-FR', long
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { weekday: 'short', day: '2-digit', month: '2-digit' });
}
function numeroSemaine(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const jeudi = new Date(d); jeudi.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const debutAnnee = new Date(jeudi.getFullYear(), 0, 4);
  return 1 + Math.round(((jeudi - debutAnnee) / 86400000 - 3 + ((debutAnnee.getDay() + 6) % 7)) / 7);
}
function ecartPct(prevu, reel) {
  if (!prevu || reel === null || reel === undefined) return null;
  return Math.round((reel - prevu) / prevu * 100);
}
function badgeEcart(p) {
  if (p === null) return '<span style="color:var(--text-muted)">—</span>';
  const a = Math.abs(p);
  const coul = a <= 10 ? 'var(--success)' : a <= 25 ? 'var(--warning)' : 'var(--danger)';
  return `<span style="color:${coul};font-weight:700">${p > 0 ? '+' : ''}${p} %</span>`;
}

// Enregistre la prévision affichée (silencieux = pas de confirmation, pour la génération de semaine)
async function enregistrerPrevision(silencieux) {
  // Un CA tapé à la main sans avoir appuyé sur « Recalculer » est appliqué avant d'enregistrer
  if (!silencieux && caManuelEnAttente && parseFloat(document.getElementById("prevCAManuel").value) > 0) appliquerCAManuel();
  const r = dernierResultat;
  if (!r || !r.dateStr) { showToast("Génère d'abord une prévision", "error"); return false; }
  if (!silencieux && r.dateStr !== document.getElementById("prevDate").value) {
    showToast("La date a changé : clique d'abord sur « Générer les prévisions »", "error"); return false;
  }
  try {
    if (!silencieux) {
      const ex = await db.collection(PREVISIONS).doc(r.dateStr).get();
      if (ex.exists && !confirm(`Une prévision existe déjà pour ${libelleJour(r.dateStr, true)}. La remplacer ?`)) return false;
    }
    await db.collection(PREVISIONS).doc(r.dateStr).set({ ...r, enregistreLe: Date.now() });
    if (!silencieux) { showToast(`✅ Prévision du ${libelleJour(r.dateStr)} enregistrée`); afficherPrevisionEnregistree(); }
    return true;
  } catch (e) {
    console.error("Enregistrement prévision :", e);
    showToast("❌ Enregistrement impossible" + (e.code === 'permission-denied' ? " (règles Firestore)" : ""), "error");
    return false;
  }
}

// Génère et enregistre les 7 jours de la semaine affichée (jours fermés ignorés),
// avec la météo et l'événement choisis dans l'onglet Prévisions.
async function genererSemaine() {
  if (!semaineLundi) return;
  const meteo = document.getElementById("prevMeteo").selectedOptions[0].textContent.trim();
  if (!confirm(`Générer et enregistrer les prévisions de toute la semaine ${numeroSemaine(semaineLundi)} ?\n\nMétéo utilisée : ${meteo} (modifiable dans l'onglet Prévisions).\nLes jours fermés sont ignorés. Les jours qui ont déjà une prévision sont recalculés avec LEUR météo et LEUR événement.`)) return;
  const btn = document.getElementById("btnGenererSemaine");
  if (btn) { btn.disabled = true; btn.textContent = "Génération en cours…"; }
  let nb = 0;
  const hidden = document.getElementById("prevDate");
  const dateAvant = hidden.value;
  const meteoDefaut = document.getElementById("prevMeteo").value, eventDefaut = document.getElementById("prevEvent").value;
  for (let i = 0; i < 7; i++) {
    const d = new Date(semaineLundi + "T12:00:00"); d.setDate(d.getDate() + i);
    if (!ouvertLe(d)) continue;
    if (await genererEtEnregistrerJour(dateStrLocale(d), meteoDefaut, eventDefaut)) nb++;
  }
  hidden.value = dateAvant; majAffichageDate();
  document.getElementById("prevMeteo").value = meteoDefaut; document.getElementById("prevEvent").value = eventDefaut;
  if (btn) { btn.disabled = false; btn.textContent = "⚡ Générer et enregistrer toute la semaine"; }
  showToast(`✅ ${nb} prévision${nb > 1 ? 's' : ''} enregistrée${nb > 1 ? 's' : ''}`);
  showTab('semaine');
}

function initSemaine() {
  if (typeof vueMode !== 'undefined' && vueMode === 'mois') { chargerMois(); return; }
  if (!semaineLundi) semaineLundi = lundiDe(dateStrLocale(new Date()));
  chargerSemaine();
}
function changerSemaine(delta) {
  const d = new Date(semaineLundi + "T12:00:00"); d.setDate(d.getDate() + 7 * delta);
  semaineLundi = dateStrLocale(d); semaineJourOuvert = null; chargerSemaine();
}
function allerSemaineDuJour() { semaineLundi = lundiDe(dateStrLocale(new Date())); semaineJourOuvert = null; chargerSemaine(); }
function allerALaDate(val) {
  if (val && typeof vueMode !== 'undefined' && vueMode === 'mois') { moisCourant = val.slice(0, 7); chargerMois(); return; }
  if (!val) return;
  semaineLundi = lundiDe(val); semaineJourOuvert = val; chargerSemaine();
}

async function chargerSemaine() {
  const dim = new Date(semaineLundi + "T12:00:00"); dim.setDate(dim.getDate() + 6);
  const dimanche = dateStrLocale(dim);
  document.getElementById("semaineTitre").textContent =
    `Semaine ${numeroSemaine(semaineLundi)} — du ${libelleJour(semaineLundi)} au ${libelleJour(dimanche)}`;
  document.getElementById("semaineTable").innerHTML = '<p class="empty-state">Chargement…</p>';
  try {
    if (Reel.user) await Reel.synchroniser(false); else await Reel.chargerJournees();
    const snap = await db.collection(PREVISIONS).where('dateStr', '>=', semaineLundi).where('dateStr', '<=', dimanche).get();
    semainePrevisions = {};
    snap.forEach(doc => { semainePrevisions[doc.id] = doc.data(); });
  } catch (e) {
    console.error("Lecture prévisions :", e);
    document.getElementById("semaineTable").innerHTML = '<p class="empty-state">❌ Lecture impossible (internet ou règles Firestore)</p>';
    return;
  }
  afficherSemaine();
}

function afficherSemaine() {
  const reels = {}; Reel.journees.forEach(j => { reels[j.dateStr] = j; });
  const aujourdhui = dateStrLocale(new Date());
  let tPrevCv = 0, tPrevCa = 0, tReelCv = 0, tReelCa = 0, tPrevCvComparable = 0, tPrevCaComparable = 0;
  const lignes = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(semaineLundi + "T12:00:00"); d.setDate(d.getDate() + i);
    const ds = dateStrLocale(d);
    const p = semainePrevisions[ds], r = reels[ds];
    const ferme = !ouvertLe(d);
    if (p) { tPrevCv += p.clientsMoy || 0; tPrevCa += p.caMoy || 0; }
    if (r) { tReelCv += r.couverts || 0; tReelCa += r.ca || 0; }
    if (p && r) { tPrevCvComparable += p.clientsMoy || 0; tPrevCaComparable += p.caMoy || 0; }
    lignes.push(`<tr onclick="ouvrirJourSemaine('${ds}')" style="cursor:pointer;${ds === semaineJourOuvert ? 'background:rgba(212,160,23,0.12);' : ''}">
      <td><strong>${libelleJour(ds)}</strong>${ds === aujourdhui ? ' <span style="color:var(--gold)">• aujourd\'hui</span>' : ''}${ferme ? ' <span style="color:var(--text-muted)">(fermé)</span>' : ''}</td>
      <td style="color:var(--gold);font-weight:600">${p ? p.clientsMoy : '—'}</td>
      <td>${p ? formatEuro(p.caMoy) : '—'}</td>
      <td style="font-weight:600">${r ? r.couverts : '—'}</td>
      <td>${r ? formatEuro(r.ca || 0) : '—'}</td>
      <td>${p && r ? badgeEcart(ecartPct(p.clientsMoy, r.couverts)) : '—'}</td>
      <td>${p && r ? badgeEcart(ecartPct(p.caMoy, r.ca)) : '—'}</td>
      <td>${p ? (p.staffMax || '—') : '—'}</td>
      <td onclick="event.stopPropagation()" style="white-space:nowrap;">${ferme && !p ? '<span style="color:var(--text-muted)">—</span>' : `
        <select title="Météo de ce jour" onchange="changerConditionsJour('${ds}', this.value, null)" style="padding:4px;border-radius:6px;background:var(--ocean-mid);color:var(--text-primary);border:1px solid var(--ocean-border);">
          ${[['', p ? '' : '— météo'], ['beau', '☀️ Beau'], ['nuageux', '⛅ Nuageux'], ['mauvais', '☁️ Mauvais']].filter(o => o[0] || !p).map(o => `<option value="${o[0]}" ${p && p.meteo === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}
        </select>
        <select title="Événement ce jour" onchange="changerConditionsJour('${ds}', null, this.value)" style="padding:4px;border-radius:6px;background:var(--ocean-mid);color:var(--text-primary);border:1px solid var(--ocean-border);">
          ${[['non', 'Aucun'], ['marche', 'Marché / fête'], ['concert', 'Concert']].map(o => `<option value="${o[0]}" ${(p ? p.event : 'non') === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}
        </select>`}</td>
    </tr>`);
  }
  document.getElementById("semaineTable").innerHTML = `
    <div class="table-wrap"><table style="min-width:640px;">
      <thead><tr><th>Jour</th><th>Couverts prévus</th><th>CA prévu</th><th>Couverts réels</th><th>CA réel</th><th>Écart couverts</th><th>Écart CA</th><th>Staff max</th><th>Météo · événement</th></tr></thead>
      <tbody>${lignes.join('')}</tbody>
      <tfoot><tr style="border-top:2px solid var(--ocean-border);font-weight:700;">
        <td>Total semaine</td><td style="color:var(--gold)">${tPrevCv || '—'}</td><td>${tPrevCa ? formatEuro(tPrevCa) : '—'}</td>
        <td>${tReelCv || '—'}</td><td>${tReelCa ? formatEuro(tReelCa) : '—'}</td>
        <td>${tPrevCvComparable ? badgeEcart(ecartPct(tPrevCvComparable, tReelCv && Object.keys(semainePrevisions).filter(ds => reels[ds]).reduce((s, ds) => s + reels[ds].couverts, 0))) : '—'}</td>
        <td>${tPrevCaComparable ? badgeEcart(ecartPct(tPrevCaComparable, Object.keys(semainePrevisions).filter(ds => reels[ds]).reduce((s, ds) => s + (reels[ds].ca || 0), 0))) : '—'}</td>
        <td></td><td></td></tr></tfoot>
    </table></div>
    <p style="font-size:0.75rem;color:var(--text-muted);margin-top:8px;">Écart = (réel − prévu) / prévu, calculé seulement sur les jours qui ont à la fois une prévision et une journée réelle. Vert ≤ 10 % · orange ≤ 25 % · rouge au-delà. Touche un jour pour voir le détail.<br>
      Changer la météo ou l'événement d'un jour recalcule et réenregistre aussitôt la prévision de ce jour (un CA ajusté à la main est alors remplacé, après confirmation).</p>`;
  if (semaineJourOuvert) ouvrirJourSemaine(semaineJourOuvert); else document.getElementById("semaineDetail").innerHTML = '';
}

function ouvrirJourSemaine(ds) {
  semaineJourOuvert = ds;
  const p = semainePrevisions[ds];
  const r = Reel.journees.find(j => j.dateStr === ds);
  const el = document.getElementById("semaineDetail");
  if (!p && !r) {
    el.innerHTML = `<div class="card"><div class="card-title">${libelleJour(ds, true)}</div>
      <p class="empty-state">Pas de prévision enregistrée ni de journée réelle pour ce jour.</p>
      <button class="btn btn-secondary" onclick="prevoirCeJour('${ds}')">📅 Faire la prévision de ce jour</button></div>`;
    el.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const reelCr = (r && r.creneaux) || {};
  const lignes = (p ? p.creneaux : Object.keys(reelCr).sort((a, b) => a - b).map(k => ({ heure: libelleCreneau(parseFloat(k)) })))
    .map(c => {
      const h = parseInt(c.heure, 10) + (String(c.heure).endsWith('30') ? 0.5 : 0);
      const rc = reelCr[h.toFixed(1)];
      const s = c.staff;
      return `<tr>
        <td><strong>${c.heure}</strong></td>
        <td style="color:var(--gold);text-align:center;">${c.arrivees ?? '—'}</td>
        <td style="text-align:center;">${rc ? rc.arrivees : (r ? 0 : '—')}</td>
        <td>${c.enSalle ?? '—'}</td>
        <td>${c.ca !== undefined ? formatEuro(c.ca) : '—'}</td>
        <td>${s ? `<div class="staff-badges">
          ${s.marmites > 0 ? `<span class="sbadge">🍲×${s.marmites}</span>` : ''}
          ${s.friteuses > 0 ? `<span class="sbadge">🍟×${s.friteuses}</span>` : ''}
          ${s.remplissage > 0 ? `<span class="sbadge">🔄×1</span>` : ''}
          <span class="sbadge">🧑‍🍳×${s.salle}</span>
          ${s.bar > 0 ? `<span class="sbadge">🍺×${s.bar}</span>` : ''}
          <span class="sbadge total-badge">= ${s.total}</span></div>` : '—'}</td></tr>`;
    }).join('');
  el.innerHTML = `<div class="card">
    <div class="card-title">${libelleJour(ds, true)}</div>
    ${p ? `<p style="font-size:0.82rem;color:var(--text-secondary);line-height:1.6;margin-bottom:10px;">
      Prévu : <strong style="color:var(--gold)">${p.clientsMoy} couverts</strong> (${p.clientsMin}–${p.clientsMax}) ·
      CA ${formatEuro(p.caMin)} / <strong>${formatEuro(p.caMoy)}</strong> / ${formatEuro(p.caMax)} · panier ${formatEuro(p.pm)}<br>
      Saison ${p.saison || '—'} · météo ${p.meteo || '—'} · événement ${p.event || '—'}${p.manuel ? ' · ✏️ CA ajusté à la main' : ''}<br>
      <span style="color:var(--text-muted)">${p.sourceLabel || ''} — enregistrée le ${p.enregistreLe ? new Date(p.enregistreLe).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span></p>`
      : '<p style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:10px;">Pas de prévision enregistrée pour ce jour.</p>'}
    ${r ? `<p style="font-size:0.82rem;margin-bottom:10px;">Réel : <strong>${r.couverts} couverts</strong> · ${r.tables} tables · CA ${formatEuro(r.ca || 0)}${r.panierCouvert ? ' · panier ' + formatEuro(r.panierCouvert) : ''}
      ${p ? ` — écart couverts ${badgeEcart(ecartPct(p.clientsMoy, r.couverts))} · écart CA ${badgeEcart(ecartPct(p.caMoy, r.ca))}` : ''}</p>` : ''}
    <div class="table-wrap"><table style="min-width:560px;">
      <thead><tr><th>Heure</th><th style="text-align:center;">Arrivées prévues</th><th style="text-align:center;">Arrivées réelles</th><th>En salle</th><th>CA prévu</th><th>Staff prévu</th></tr></thead>
      <tbody>${lignes}</tbody></table></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
      <button class="btn btn-secondary" style="width:auto;" onclick="prevoirCeJour('${ds}')">📅 Refaire la prévision de ce jour</button>
      ${p ? `<button class="btn btn-secondary" style="width:auto;" onclick="supprimerPrevision('${ds}')">🗑️ Supprimer cette prévision</button>` : ''}
    </div></div>`;
  afficherSemaineSelection();
  el.scrollIntoView({ behavior: 'smooth' });
}
function afficherSemaineSelection() {
  document.querySelectorAll('#semaineTable tbody tr').forEach((tr, i) => {
    const d = new Date(semaineLundi + "T12:00:00"); d.setDate(d.getDate() + i);
    tr.style.background = dateStrLocale(d) === semaineJourOuvert ? 'rgba(212,160,23,0.12)' : '';
  });
}
function prevoirCeJour(ds) {
  document.getElementById("prevDate").value = ds;
  showTab('previsions');
  parametresChanges(); // si une prévision d'un autre jour était affichée, elle est recalculée pour ce jour
  showToast("Choisis la météo / l'événement puis « Générer les prévisions »");
}
async function supprimerPrevision(ds) {
  if (!confirm(`Supprimer la prévision du ${libelleJour(ds, true)} ?`)) return;
  try { await db.collection(PREVISIONS).doc(ds).delete(); semaineJourOuvert = null; chargerSemaine(); showToast("Prévision supprimée"); }
  catch (e) { showToast("❌ Suppression impossible", "error"); }
}

// ============================================================
// VUE DU MOIS ENTIER (17/10/2026)
// Calendrier lundi → dimanche du mois, avec pour chaque jour le prévu et le réel,
// un total par semaine (colonne de droite) et le total du mois.
// Un clic sur un jour ouvre ce jour dans la vue Semaine (avec son détail).
// ============================================================
let vueMode = 'semaine';   // 'semaine' | 'mois'
let moisCourant = null;    // "AAAA-MM"
const NOMS_MOIS = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];

function changerVue(mode) {
  vueMode = mode;
  document.getElementById("btnVueSemaine").className = 'btn ' + (mode === 'semaine' ? 'btn-primary' : 'btn-secondary');
  document.getElementById("btnVueMois").className = 'btn ' + (mode === 'mois' ? 'btn-primary' : 'btn-secondary');
  document.getElementById("btnGenererSemaine").textContent = mode === 'mois'
    ? "⚡ Générer et enregistrer tout le mois" : "⚡ Générer et enregistrer toute la semaine";
  if (mode === 'mois' && !moisCourant) moisCourant = (semaineLundi || dateStrLocale(new Date())).slice(0, 7);
  if (mode === 'mois') { document.getElementById("semaineDetail").innerHTML = ''; chargerMois(); }
  else initSemaine();
}
function changerPeriode(delta) {
  if (vueMode === 'mois') {
    const [a, m] = moisCourant.split('-').map(Number);
    const d = new Date(a, m - 1 + delta, 1, 12);
    moisCourant = dateStrLocale(d).slice(0, 7); chargerMois();
  } else changerSemaine(delta);
}
function allerPeriodeDuJour() {
  if (vueMode === 'mois') { moisCourant = dateStrLocale(new Date()).slice(0, 7); chargerMois(); }
  else allerSemaineDuJour();
}
function genererPeriode() { return vueMode === 'mois' ? genererMois() : genererSemaine(); }

function joursDuMois(mois) {
  const [a, m] = mois.split('-').map(Number);
  const res = [];
  for (let d = new Date(a, m - 1, 1, 12); d.getMonth() === m - 1; d.setDate(d.getDate() + 1)) res.push(dateStrLocale(d));
  return res;
}

async function genererMois() {
  const jours = joursDuMois(moisCourant).filter(ds => ouvertLe(new Date(ds + "T12:00:00")));
  const [a, m] = moisCourant.split('-').map(Number);
  const meteo = document.getElementById("prevMeteo").selectedOptions[0].textContent.trim();
  if (!jours.length) { showToast("Restaurant fermé tout ce mois-ci", "error"); return; }
  if (!confirm(`Générer et enregistrer les ${jours.length} jours ouverts de ${NOMS_MOIS[m - 1]} ${a} ?\n\nMétéo utilisée : ${meteo} (modifiable dans l'onglet Prévisions).\nLes jours qui ont déjà une prévision sont recalculés avec LEUR météo et LEUR événement.`)) return;
  const btn = document.getElementById("btnGenererSemaine");
  btn.disabled = true;
  const hidden = document.getElementById("prevDate"), dateAvant = hidden.value;
  const meteoDefaut = document.getElementById("prevMeteo").value, eventDefaut = document.getElementById("prevEvent").value;
  let nb = 0;
  for (const ds of jours) {
    btn.textContent = `Génération… ${nb + 1}/${jours.length}`;
    if (await genererEtEnregistrerJour(ds, meteoDefaut, eventDefaut)) nb++;
  }
  hidden.value = dateAvant; majAffichageDate();
  document.getElementById("prevMeteo").value = meteoDefaut; document.getElementById("prevEvent").value = eventDefaut;
  btn.disabled = false; btn.textContent = "⚡ Générer et enregistrer tout le mois";
  showToast(`✅ ${nb} prévision${nb > 1 ? 's' : ''} enregistrée${nb > 1 ? 's' : ''}`);
  showTab('semaine');
}

async function chargerMois() {
  const jours = joursDuMois(moisCourant);
  const [a, m] = moisCourant.split('-').map(Number);
  document.getElementById("semaineTitre").textContent = `${NOMS_MOIS[m - 1].charAt(0).toUpperCase() + NOMS_MOIS[m - 1].slice(1)} ${a}`;
  document.getElementById("semaineTable").innerHTML = '<p class="empty-state">Chargement…</p>';
  try {
    if (Reel.user) await Reel.synchroniser(false); else await Reel.chargerJournees();
    const snap = await db.collection(PREVISIONS).where('dateStr', '>=', jours[0]).where('dateStr', '<=', jours[jours.length - 1]).get();
    semainePrevisions = {};
    snap.forEach(doc => { semainePrevisions[doc.id] = doc.data(); });
  } catch (e) {
    console.error("Lecture prévisions du mois :", e);
    document.getElementById("semaineTable").innerHTML = '<p class="empty-state">❌ Lecture impossible (internet ou règles Firestore)</p>';
    return;
  }
  afficherMois();
}

function afficherMois() {
  const jours = joursDuMois(moisCourant);
  const reels = {}; Reel.journees.forEach(j => { reels[j.dateStr] = j; });
  const aujourdhui = dateStrLocale(new Date());
  const premierLundi = lundiDe(jours[0]);
  const tot = { pCv: 0, pCa: 0, rCv: 0, rCa: 0, cpCv: 0, cpCa: 0, crCv: 0, crCa: 0, nbPrev: 0, nbOuverts: 0 };
  let html = '';
  let d = new Date(premierLundi + "T12:00:00");
  while (dateStrLocale(d) <= jours[jours.length - 1]) {
    let ligne = '';
    const sem = { pCa: 0, rCa: 0, pCv: 0, rCv: 0, lundi: dateStrLocale(d) };
    for (let i = 0; i < 7; i++) {
      const ds = dateStrLocale(d);
      const dansMois = ds.slice(0, 7) === moisCourant;
      const p = dansMois ? semainePrevisions[ds] : null, r = dansMois ? reels[ds] : null;
      const ferme = !ouvertLe(d);
      if (dansMois) {
        if (!ferme) tot.nbOuverts++;
        if (p) { tot.pCv += p.clientsMoy || 0; tot.pCa += p.caMoy || 0; tot.nbPrev++; sem.pCa += p.caMoy || 0; sem.pCv += p.clientsMoy || 0; }
        if (r) { tot.rCv += r.couverts || 0; tot.rCa += r.ca || 0; sem.rCa += r.ca || 0; sem.rCv += r.couverts || 0; }
        if (p && r) { tot.cpCv += p.clientsMoy || 0; tot.cpCa += p.caMoy || 0; tot.crCv += r.couverts || 0; tot.crCa += r.ca || 0; }
      }
      const fond = !dansMois ? 'opacity:0.25;' : ferme ? 'opacity:0.5;' : '';
      const bord = ds === aujourdhui ? 'border:2px solid var(--gold);' : 'border:1px solid var(--ocean-border);';
      ligne += `<td onclick="${dansMois ? `ouvrirJourDepuisMois('${ds}')` : ''}" style="vertical-align:top;padding:6px;${bord}${fond}${dansMois ? 'cursor:pointer;' : ''}min-width:84px;">
        <div style="font-weight:700;font-size:0.8rem;">${d.getDate()}${ferme && dansMois ? ' <span style="font-weight:400;color:var(--text-muted)">fermé</span>' : ''}</div>
        ${p ? `<div style="color:var(--gold);font-size:0.78rem;">${({ beau: '☀️ ', nuageux: '⛅ ', mauvais: '☁️ ' })[p.meteo] || ''}${p.event && p.event !== 'non' ? '🎉 ' : ''}${p.clientsMoy} cv · ${Math.round(p.caMoy)} €</div>` : (dansMois && !ferme ? '<div style="font-size:0.72rem;color:var(--text-muted)">pas de prévision</div>' : '')}
        ${r ? `<div style="font-size:0.78rem;">réel ${r.couverts} cv · ${Math.round(r.ca || 0)} €</div>` : ''}
        ${p && r ? `<div style="font-size:0.75rem;">${badgeEcart(ecartPct(p.caMoy, r.ca))}</div>` : ''}
      </td>`;
      d.setDate(d.getDate() + 1);
    }
    ligne += `<td style="vertical-align:top;padding:6px;border:1px solid var(--ocean-border);background:rgba(212,160,23,0.08);min-width:96px;">
      <div style="font-weight:700;font-size:0.75rem;">Sem. ${numeroSemaine(sem.lundi)}</div>
      <div style="color:var(--gold);font-size:0.78rem;">${sem.pCa ? sem.pCv + ' cv · ' + Math.round(sem.pCa) + ' €' : '—'}</div>
      ${sem.rCa ? `<div style="font-size:0.78rem;">réel ${sem.rCv} cv · ${Math.round(sem.rCa)} €</div>` : ''}
    </td>`;
    html += `<tr>${ligne}</tr>`;
  }
  document.getElementById("semaineTable").innerHTML = `
    <div class="kpi-grid" style="margin-bottom:12px;">
      <div class="kpi-card"><div class="kpi-value" style="font-size:1.2rem;">${tot.pCa ? formatEuro(tot.pCa) : '—'}</div><div class="kpi-label">CA prévu (${tot.nbPrev}/${tot.nbOuverts} jours ouverts prévus)</div></div>
      <div class="kpi-card"><div class="kpi-value" style="font-size:1.2rem;">${tot.pCv || '—'}</div><div class="kpi-label">Couverts prévus</div></div>
      <div class="kpi-card"><div class="kpi-value" style="font-size:1.2rem;">${tot.rCa ? formatEuro(tot.rCa) : '—'}</div><div class="kpi-label">CA réel</div></div>
      <div class="kpi-card"><div class="kpi-value" style="font-size:1.2rem;">${tot.rCv || '—'}</div><div class="kpi-label">Couverts réels</div></div>
      <div class="kpi-card"><div class="kpi-value" style="font-size:1.2rem;">${tot.cpCa ? badgeEcart(ecartPct(tot.cpCa, tot.crCa)) : '—'}</div><div class="kpi-label">Écart CA (jours prévus et réalisés)</div></div>
      <div class="kpi-card"><div class="kpi-value" style="font-size:1.2rem;">${tot.cpCv ? badgeEcart(ecartPct(tot.cpCv, tot.crCv)) : '—'}</div><div class="kpi-label">Écart couverts</div></div>
    </div>
    <div class="table-wrap"><table style="min-width:720px;border-collapse:collapse;">
      <thead><tr><th>Lun</th><th>Mar</th><th>Mer</th><th>Jeu</th><th>Ven</th><th>Sam</th><th>Dim</th><th>Semaine</th></tr></thead>
      <tbody>${html}</tbody>
    </table></div>
    <p style="font-size:0.75rem;color:var(--text-muted);margin-top:8px;">cv = couverts. En or : prévu · en blanc : réel · pourcentage : écart de CA (vert ≤ 10 %, orange ≤ 25 %, rouge au-delà). Touche un jour pour ouvrir son détail.</p>`;
}

function ouvrirJourDepuisMois(ds) {
  semaineLundi = lundiDe(ds);
  semaineJourOuvert = ds;
  changerVue('semaine');
}


// ============================================================
// MÉTÉO / ÉVÉNEMENT JOUR PAR JOUR (depuis le tableau de la semaine)
// Recalcule la prévision du jour avec les nouvelles conditions et l'enregistre aussitôt.
// ============================================================
async function changerConditionsJour(ds, meteo, event) {
  const p = semainePrevisions[ds];
  const nouvelleMeteo = meteo !== null ? meteo : (p ? p.meteo : document.getElementById("prevMeteo").value);
  const nouvelEvent = event !== null ? event : (p ? p.event : 'non');
  if (!nouvelleMeteo) return;
  if (p && p.manuel && !confirm(`Le ${libelleJour(ds, true)} avait un CA ajusté à la main (${formatEuro(p.caMoy)}). Le recalculer avec les nouvelles conditions ?`)) {
    afficherSemaine(); return;
  }
  const champs = ["prevDate", "prevMeteo", "prevEvent", "prevSaison"].map(id => document.getElementById(id));
  const avant = champs.map(c => c.value);
  try {
    champs[0].value = ds;
    majAffichageDate();                   // saison automatique selon la date
    champs[1].value = nouvelleMeteo;
    champs[2].value = nouvelEvent;
    await genererPrevisions();
    if (await enregistrerPrevision(true)) {
      semainePrevisions[ds] = { ...dernierResultat, enregistreLe: Date.now() };
      showToast(`✅ ${libelleJour(ds)} recalculé : ${dernierResultat.clientsMoy} couverts · ${formatEuro(dernierResultat.caMoy)}`);
    }
  } finally {
    champs.forEach((c, i) => { c.value = avant[i]; });
    majAffichageDate();
    champs[3].value = avant[3];
  }
  semaineJourOuvert = ds;
  await chargerSemaine();
}


// Génère et enregistre UN jour pour « toute la semaine / tout le mois » :
// si le jour a déjà une prévision, on garde sa météo et son événement (réglés jour par jour) ;
// sinon on prend la météo et l'événement choisis dans l'onglet Prévisions.
async function genererEtEnregistrerJour(ds, meteoDefaut, eventDefaut) {
  let meteo = meteoDefaut, evt = eventDefaut;
  try {
    const ex = await db.collection(PREVISIONS).doc(ds).get();
    if (ex.exists) { meteo = ex.data().meteo || meteo; evt = ex.data().event || evt; }
  } catch (e) { /* hors ligne : valeurs par défaut */ }
  document.getElementById("prevDate").value = ds;
  majAffichageDate();               // saison automatique selon la date
  document.getElementById("prevMeteo").value = meteo;
  document.getElementById("prevEvent").value = evt;
  await genererPrevisions();
  return enregistrerPrevision(true);
}
