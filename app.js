/*
  LOCT PRO — aplicativo do ISBET.
  Modo local: teste das telas e dos alertas entre abas do mesmo navegador.
  Firebase configurado: mensagens e confirmações em tempo real entre celulares.
  A localização exibida é fixa para esta versão. Nenhum GPS é acessado.
  Nome especial: somente seleciona a interface nesta versão; não é uma senha.
*/
(() => {
  'use strict';

  const OWNER_NAME = 'DAPHINE KITSUNE MOTA';
  
  
  const MAP_POINT = [-22.904382942609402, -47.06143346474497];

 // aproximação do edifício na Rua General Osório, 865
  const ADDRESS = 'Rua General Osório — Campinas, SP';
  const FIREBASE_VERSION = '12.4.0';
  const $ = (id) => document.getElementById(id);
  const views = ['loginView', 'ownerView', 'joinView', 'contactView'];
  const state = {
    backend: null,
    mode: 'local',
    role: null,
    name: '',
    code: '',
    uid: '',
    latestRoom: null,
    unsub: null,
    lastAlertShown: '',
    audio: null,
    alertVisible: false,
    maps: {},
    loading: false,
    toastTimeout: null
  };

  function showView(viewId) {
    for (const id of views) $(id).classList.toggle('hidden', id !== viewId);
    window.scrollTo({top: 0, behavior: 'instant'});
    if (viewId === 'ownerView') requestAnimationFrame(() => displayMap('ownerMap'));
    if (viewId === 'contactView') requestAnimationFrame(() => displayMap('contactMap'));
  }
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(state.toastTimeout);
    state.toastTimeout = setTimeout(() => el.classList.add('hidden'), 4300);
  }
  function setBadge(message) { $('connectionBadge').textContent = message; }
  function normalizedName(value) {
    return value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').toUpperCase();
  }
  function makeCode() {
    const bytes = new Uint32Array(1);
    if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes); else bytes[0] = Math.floor(Math.random() * 4294967295);
    return 'LOCT-' + String(bytes[0] % 1000000).padStart(6, '0');
  }
  function normalizeCode(value) {
    return value.trim().toUpperCase().replace(/\s/g, '').replace(/^LOCT-?/, 'LOCT-');
  }
  function initials(name) {
    const parts = name.trim().split(/\s+/);
    return (parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
  }
  function safeSessionGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
  function safeSessionSet(key, value) { try { sessionStorage.setItem(key, value); } catch {} }
  function safeSessionRemove(key) { try { sessionStorage.removeItem(key); } catch {} }
  function configured() {
    const c = window.LOCT_FIREBASE_CONFIG;
    return Boolean(c && c.apiKey && c.databaseURL && c.projectId && c.appId &&
      !Object.values(c).some(v => typeof v === 'string' && /COLE_AQUI|SEU_PROJETO|SEU_BANCO/i.test(v)));
  }
  async function ensureBackend() {
    if (state.backend) return state.backend;
    if (!configured()) {
      state.mode = 'local';
      state.backend = new LocalBackend();
      state.uid = state.backend.uid;
      setBadge('Modo de teste · somente este navegador');
      return state.backend;
    }
    const cloud = new CloudBackend(window.LOCT_FIREBASE_CONFIG);
    await cloud.init();
    state.backend = cloud;
    state.mode = 'cloud';
    state.uid = cloud.uid;
    setBadge('Conectado ao Firebase · online');
    return state.backend;
  }

  class LocalBackend {
    constructor() {
      this.uid = safeSessionGet('loct-device-id');
      if (!this.uid) {
        this.uid = 'local-' + (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)));
        safeSessionSet('loct-device-id', this.uid);
      }
      this.listeners = [];
      this.channel = 'BroadcastChannel' in window ? new BroadcastChannel('loct-pro-demo') : null;
      this.channel?.addEventListener('message', () => this.notify(false));
      window.addEventListener('storage', (e) => { if (e.key?.startsWith('loct-room-')) this.notify(false); });
    }
    key(code) { return `loct-room-${code}`; }
    async readRoom(code) {
      try { return JSON.parse(localStorage.getItem(this.key(code)) || 'null'); } catch { return null; }
    }
    async createRoom(code, data) {
      if (await this.readRoom(code)) throw new Error('Código já utilizado. Tente criar outra sessão.');
      localStorage.setItem(this.key(code), JSON.stringify(data));
      this.notify();
    }
    async mutate(code, change) {
      const room = await this.readRoom(code);
      if (!room) throw new Error('Sessão não encontrada.');
      change(room);
      localStorage.setItem(this.key(code), JSON.stringify(room));
      this.notify();
    }
    async setAlert(code, alert) { await this.mutate(code, room => { room.alert = alert; }); }
   

async registerContact(code, uid, name) {
  await this.mutate(code, room => {
    room.contacts ||= {};

    room.contacts[uid] = {
      name,
      online: true,
      joinedAt: Date.now(),
      ackedAlertId: ''
    };
  });
}

    async ack(code, uid, id) { await this.mutate(code, room => { if (room.contacts?.[uid]) room.contacts[uid].ackedAlertId = id; }); }
    async leave(code, uid) { await this.mutate(code, room => { if (room.contacts?.[uid]) room.contacts[uid].online = false; }); }
    subscribe(code, cb) {
      const fn = async () => cb(await this.readRoom(code));
      const item = {code, fn};
      this.listeners.push(item);
      void fn();
      return () => { this.listeners = this.listeners.filter(x => x !== item); };
    }
    notify(broadcast = true) {
      if (broadcast) this.channel?.postMessage('update');
      for (const item of [...this.listeners]) void item.fn();
    }
  }

  class CloudBackend {
    constructor(config) { this.config = config; this.uid = ''; }
    async init() {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
      const [appMod, authMod, dbMod] = await Promise.all([
        import(`${base}/firebase-app.js`),
        import(`${base}/firebase-auth.js`),
        import(`${base}/firebase-database.js`)
      ]);
      this.dbApi = dbMod;
      this.app = appMod.initializeApp(this.config);
      this.auth = authMod.getAuth(this.app);
      this.db = dbMod.getDatabase(this.app);
      if (!this.auth.currentUser) await authMod.signInAnonymously(this.auth);
      this.uid = this.auth.currentUser?.uid;
      if (!this.uid) throw new Error('Falha ao autenticar no Firebase.');
    }
    path(code) { return `rooms/${code}`; }
    async readRoom(code) {
      const {get, ref} = this.dbApi;
      const snapshot = await get(ref(this.db, this.path(code)));
      return snapshot.exists() ? snapshot.val() : null;
    }
    async createRoom(code, data) {
      const {set, ref} = this.dbApi;
      await set(ref(this.db, this.path(code)), data);
    }
    async setAlert(code, alert) {
      const {update, ref} = this.dbApi;
      await update(ref(this.db, this.path(code)), { alert });
    }
    
async registerContact(code, uid, name) {
  const { set, ref, onDisconnect, onValue } = this.dbApi;

  const contact = ref(
    this.db,
    `${this.path(code)}/contacts/${uid}`
  );

  // Cadastra o contato no Firebase.
  await set(contact, {
    name,
    online: true,
    joinedAt: Date.now(),
    ackedAlertId: ''
  });

  // Marca o contato como offline ao desconectar.
  await onDisconnect(contact).update({
    online: false
  });

  if (this.connectionUnsub) {
    this.connectionUnsub();
  }

  this.connectionUnsub = onValue(
    ref(this.db, '.info/connected'),
    snapshot => {
      if (
        snapshot.val() === true &&
        state.code === code &&
        state.role === 'contact'
      ) {
        void onDisconnect(contact)
          .update({ online: false })
          .catch(console.warn);

        void this.dbApi
          .update(contact, { online: true })
          .catch(console.warn);
      }
    }
  );
}

    async ack(code, uid, id) {
      const {update, ref} = this.dbApi;
      await update(ref(this.db, `${this.path(code)}/contacts/${uid}`), {ackedAlertId: id});
    }
    async leave(code, uid) {
      const {update, ref, onDisconnect} = this.dbApi;
      const contact = ref(this.db, `${this.path(code)}/contacts/${uid}`);
      this.connectionUnsub?.();
      this.connectionUnsub = null;
      await onDisconnect(contact).cancel();
      await update(contact, {online: false});
    }
    subscribe(code, cb) {
      const {onValue, ref} = this.dbApi;
      return onValue(ref(this.db, this.path(code)), snap => cb(snap.exists() ? snap.val() : null),
        error => toast('Não foi possível acompanhar a sala: ' + readableError(error)));
    }
  }
  function readableError(err) {
    const code = err?.code || '';
    if (code.includes('permission-denied')) return 'confira as regras e o código de acesso.';
    if (code.includes('auth/operation-not-allowed')) return 'ative a autenticação anônima no Firebase.';
    if (code.includes('auth/unauthorized-domain')) return 'cadastre o domínio em Firebase Authentication.';
    return err?.message?.slice(0, 180) || 'erro desconhecido';
  }
  function leaveListening() { state.unsub?.(); state.unsub = null; }

  

function displayMap(id) {
  const el = $(id);

  if (!el || el.closest('.hidden')) return;

  // Se o mapa já existe, atualiza somente seu tamanho.
  if (state.maps[id]) {
    setTimeout(() => {
      state.maps[id].invalidateSize();
    }, 150);
    return;
  }

  if (!window.L) {
    el.textContent = 'Não foi possível carregar o mapa.';
    return;
  }

  // Cria o mapa colorido e navegável.
  const map = L.map(el, {
    center: MAP_POINT,
    zoom: 17,
    zoomControl: true,
    dragging: true,
    touchZoom: true,
    doubleClickZoom: true,
    scrollWheelZoom: false
  });

  // Mapa colorido - OpenStreetMap Humanitarian.
  const tiles = L.tileLayer(
    'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    {
      minZoom: 3,
      maxZoom: 19,
      attribution:
        '&copy; OpenStreetMap contributors | HOT'
    }
  );

  tiles.addTo(map);

  // Ajuda a identificar imagens bloqueadas.
  tiles.on('tileerror', function (event) {
    console.warn(
      'Falha ao carregar uma parte do mapa:',
      event.tile?.src
    );
  });

  // Marcador personalizado com sua foto.
  const photoIcon = L.divIcon({
    className: 'loct-photo-icon',
    html: `
      <span class="loct-photo-pin">
        <img
          src="assets/perfil-1.png"
          alt="Foto de perfil"
        >
      </span>
    `,
    iconSize: [54, 69],
    iconAnchor: [27, 65],
    popupAnchor: [0, -66]
  });

  // Localização fixa: o usuário pode navegar
  // pelo mapa, mas não arrastar a foto.
  const marker = L.marker(MAP_POINT, {
    icon: photoIcon,
    draggable: false,
    title: ADDRESS
  });

  marker.addTo(map);
  marker.bindPopup(ADDRESS);

  state.maps[id] = map;

  // Ajusta o mapa quando a tela fica visível.
  requestAnimationFrame(() => {
    map.invalidateSize();
  });

  setTimeout(() => {
    map.invalidateSize();
  }, 250);
}


  // O áudio só pode ser iniciado mediante interação do usuário em muitos navegadores móveis.
  function soundContext() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    if (!state.audio) state.audio = new Context();
    void state.audio.resume().catch(() => {});
    return state.audio;
  }
  function chirp(duration = 0.22) {
    const ctx = soundContext();
    if (!ctx || ctx.state !== 'running') return false;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(740, t);
    osc.frequency.exponentialRampToValueAtTime(1000, t + duration);
    gain.gain.setValueAtTime(.0001, t);
    gain.gain.exponentialRampToValueAtTime(.09, t + .025);
    gain.gain.exponentialRampToValueAtTime(.0001, t + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t); osc.stop(t + duration + .01);
    return true;
  }
  
function alarmSound() {
  const ctx = soundContext();

  if (!ctx || ctx.state !== 'running') {
    return false;
  }

  // Evita tocar duas sirenes ao mesmo tempo.
  stopAlarmSound();

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  const start = ctx.currentTime;
  const duration = 10;

  osc.type = 'square';

  // Volume da sirene.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(0.04, start + 0.03);

  // Alterna entre dois tons durante 10 segundos.
  for (let i = 0; i < 40; i++) {
    osc.frequency.setValueAtTime(
      i % 2 === 0 ? 900 : 630,
      start + i * 0.25
    );
  }

  // Encerra automaticamente após 10 segundos.
  gain.gain.setValueAtTime(0.04, start + 9.85);
  gain.gain.linearRampToValueAtTime(0.0001, start + 10);

  osc.connect(gain);
  gain.connect(ctx.destination);

  state.alarmOscillator = osc;
  state.alarmGain = gain;

  osc.onended = () => {
    if (state.alarmOscillator === osc) {
      state.alarmOscillator = null;
      state.alarmGain = null;
    }
  };

  osc.start(start);
  osc.stop(start + duration);

  if (navigator.vibrate) {
    navigator.vibrate([300, 150, 300]);
  }

  return true;
}


function stopAlarmSound() {
  if (state.alarmGain && state.audio) {
    const now = state.audio.currentTime;

    state.alarmGain.gain.cancelScheduledValues(now);
    state.alarmGain.gain.setValueAtTime(
      0.0001,
      now
    );
  }

  if (state.alarmOscillator) {
    try {
      state.alarmOscillator.stop();
    } catch (error) {
      // O áudio pode já ter terminado.
    }
  }

  state.alarmOscillator = null;
  state.alarmGain = null;

  if (navigator.vibrate) {
    navigator.vibrate(0);
  }
}


  async function openOwner() {
    state.role = 'owner';
    state.lastAlertShown = '';
    const previous = safeSessionGet('loct-owner-code');
    let reuse = null;
    if (previous) {
      try { reuse = await state.backend.readRoom(previous); } catch {}
    }
    if (reuse && reuse.ownerUid === state.uid) {
      state.code = previous;
    } else {
      let done = false;
      for(let i=0; i<4 && !done; i++) {
        const code = makeCode();
        try {
          await state.backend.createRoom(code, {
            ownerUid: state.uid, createdAt: Date.now(),
            locationLabel: ADDRESS,
            alert: {active: false, id:'', startedAt: 0},
            contacts: {}
          });
          state.code = code;
          done = true;
        } catch (err) {
          if (i === 3) throw err;
        }
      }
    }
    safeSessionSet('loct-owner-code', state.code);
    $('ownerCode').textContent = state.code;
    showView('ownerView');
    leaveListening();
    state.unsub = state.backend.subscribe(state.code, room => {
      if (!room) return toast('Esta sessão não está mais disponível.');
      state.latestRoom = room;
      renderContacts(room.contacts || {}, room.alert || {});
      const active = Boolean(room.alert?.active);
      $('ownerAlertChip').textContent = active ? 'Alerta ativo' : 'Sem alertas';
      $('ownerAlertChip').className = 'chip ' + (active ? 'alert-chip' : 'neutral');
      $('ownerAlertStatus').textContent = active ? 'Alerta enviado. Aguarde os contatos confirmarem o recebimento.' : 'Nenhum alerta em andamento.';
    });
  }
  function renderContacts(contacts, alert) {
    const list = $('contactsList');
    list.replaceChildren();
    const people = Object.values(contacts || {}).filter(item => item?.name);
    const online = people.filter(item => item.online);
    $('contactCount').textContent = String(online.length);
    if (!people.length) {
      const p = document.createElement('p');
      p.className = 'empty-text';
      p.textContent = 'Aguardando contatos entrarem com seu código…';
      list.appendChild(p);
      return;
    }
    people.sort((a,b)=> Number(b.online) - Number(a.online));
    for (const person of people) {
      const row = document.createElement('div');
      row.className = 'contact-item';
      const left = document.createElement('div');
      left.className = 'contact-item-main';
      const avatar = document.createElement('div');
      avatar.className = 'contact-avatar';
      avatar.textContent = initials(person.name).toUpperCase();
      const info = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = person.name;
      const note = document.createElement('span'); note.textContent = person.online ? 'Conectado' : 'Desconectado';
      info.append(name, note); left.append(avatar, info);
      const status = document.createElement('span');
      const acknowledged = Boolean(alert.id && person.ackedAlertId === alert.id);
      status.className = 'contact-state' + (acknowledged ? ' ack' : '');
      status.textContent = acknowledged ? '✓ Confirmado' : person.online ? '● Online' : 'Offline';
      row.append(left, status); list.appendChild(row);
    }
  }
  async function openJoin() {
    state.role = 'contact';
    $('greeting').textContent = 'Olá, ' + state.name.split(/\s+/)[0] + '!';
    showView('joinView');
  }
  async function connectContact() {
    const code = normalizeCode($('codeField').value);
    if (!/^LOCT-\d{6}$/.test(code)) return toast('Digite um código no formato LOCT-123456.');
    const room = await state.backend.readRoom(code);
    if (!room) return toast('Código não encontrado. Confira com o usuário principal.');
    state.role = 'contact'; state.code = code;
    await state.backend.registerContact(code, state.uid, state.name);
    $('contactSessionCode').textContent = code;
    $('contactGreeting').textContent = 'Olá, ' + state.name.split(/\s+/)[0] + '!';
    showView('contactView');
    state.lastAlertShown = '';
    leaveListening();
    state.unsub = state.backend.subscribe(code, updated => {
      if (!updated) return toast('Esta sessão foi encerrada.');
      state.latestRoom = updated;
      const alert = updated.alert || {};
      const active = Boolean(alert.active);
      $('contactAlertChip').textContent = active ? 'Alerta ativo' : 'Monitorando';
      $('contactAlertChip').className = 'chip ' + (active ? 'alert-chip' : 'green-chip');
      $('contactStatusText').textContent = active ? 'Pedido de ajuda recebido. Confira o mapa e confirme o aviso.' : 'Tudo tranquilo por enquanto. Aguardando um possível alerta.';
      const acknowledged = updated.contacts?.[state.uid]?.ackedAlertId === alert.id;
      if (active && alert.id && alert.id !== state.lastAlertShown && !acknowledged) {
        state.lastAlertShown = alert.id;
        showAlert(alert);
      }
      if (!active) hideAlert();
    });
    toast('Conectado! Mantenha esta página aberta e com volume ligado.');
  }
  function showAlert(alert) {
    state.alertVisible = true;
    $('alertModal').classList.remove('hidden');
    $('alertClock').textContent = new Date(alert.startedAt || Date.now()).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
    const played = alarmSound();
    if (!played) toast('Alerta recebido! Som bloqueado pelo navegador: toque em Testar som após fechar.');
  }

function hideAlert() {
  stopAlarmSound();

  state.alertVisible = false;

  $('alertModal').classList.add('hidden');
}

  async function safeAction(fn) {
    if (state.loading) return;
    setBusy(true);
    try { await fn(); } catch (err) { console.error(err); toast('Não foi possível concluir: ' + readableError(err)); }
    finally { setBusy(false); }
  }


function setBusy(on) {
  state.loading = on;

  const buttons = [
    'enterBtn',
    'emitAlertBtn',
    'cancelAlertBtn',
    'connectBtn',
    'ackButton'
  ];

  for (const id of buttons) {
    const button = document.getElementById(id);

    if (button) {
      button.disabled = on;
    }
  }
}


  $('loginForm').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('nameField').value.trim().replace(/\s+/g,' ');
    if (!name) return;
    void safeAction(async () => {
      await ensureBackend();
      state.name = name;
      if (normalizedName(name) === OWNER_NAME) await openOwner();
      else await openJoin();
    });
  });
  $('joinForm').addEventListener('submit', event => {
    event.preventDefault();
    // IMPORTANTE: áudio iniciado diretamente no clique, antes de chamadas assíncronas.
    const ctx = soundContext();
    if (ctx) void ctx.resume().then(() => { $('soundStatus').textContent = 'Som habilitado (quando permitido pelo celular)'; });
    void safeAction(connectContact);
  });
  $('copyCodeBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.code); toast('Código copiado!'); }
    catch { toast('Seu código: ' + state.code); }
  });
  $('emitAlertBtn').addEventListener('click', () => void safeAction(async () => {
    if (state.role !== 'owner') return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    await state.backend.setAlert(state.code, {active: true, id, startedAt: Date.now()});
    toast('Alerta emitido aos contatos conectados.');
  }));
  $('cancelAlertBtn').addEventListener('click', () => void safeAction(async () => {
    if (state.role !== 'owner') return;
    await state.backend.setAlert(state.code, {active: false, id: state.latestRoom?.alert?.id || '', startedAt: state.latestRoom?.alert?.startedAt || 0});
    toast('Alerta encerrado.');
  }));
  $('testSoundBtn').addEventListener('click', () => {
    const ctx = soundContext();
    if (!ctx) return toast('Seu navegador não suporta reprodução por Web Audio.');
    void ctx.resume().then(() => {
      const ok = chirp();
      $('soundStatus').textContent = ok ? 'Som de teste reproduzido ✓' : 'Som não disponível no navegador';
      if (!ok) toast('Ative o volume e verifique as permissões de áudio do celular.');
    });
  });
  $('ackButton').addEventListener('click', () => void safeAction(async () => {
    const id = state.latestRoom?.alert?.id;
    if (id && state.role === 'contact') await state.backend.ack(state.code, state.uid, id);
    hideAlert(); toast('Recebimento confirmado para o usuário.');
  }));
  $('dismissButton').addEventListener('click', hideAlert);
  $('joinBackBtn').addEventListener('click', () => showView('loginView'));
  $('ownerLeaveBtn').addEventListener('click', () => { leaveListening(); state.role = null; state.code = ''; showView('loginView'); });
  $('contactLeaveBtn').addEventListener('click', () => void safeAction(async () => {
    if (state.role === 'contact' && state.code) await state.backend.leave(state.code, state.uid);
    leaveListening(); state.role = null; state.code = ''; hideAlert(); showView('loginView');
  }));
  $('codeField').addEventListener('input', () => {
    const el = $('codeField');
    const text = el.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    const digits = text.replace(/^LOCT/,'').replace(/\D/g,'').slice(0,6);
    el.value = digits ? 'LOCT-' + digits : (text.startsWith('LOCT') ? 'LOCT-' : '');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.alertVisible && state.audio?.state === 'suspended') {
      // A tela visual permanece mesmo quando o SO bloqueia áudio em segundo plano.
      $('soundStatus').textContent = 'Abra o app e toque em Testar som, se necessário.';
    }
  });
  showView('loginView');
})();
