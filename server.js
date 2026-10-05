import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { buildErpDispatchPlan } from './erp-pricing.js';
import { generateVisitRouteDates } from './visit-route-schedule.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const db = new DatabaseSync(join(root, 'forca-vendas.sqlite'));
const erpKeyPath=join(root,'.erp-config-key');
let erpConfigKey;
async function getErpConfigKey(){if(erpConfigKey)return erpConfigKey;if(process.env.ERP_CONFIG_ENCRYPTION_KEY){erpConfigKey=createHash('sha256').update(process.env.ERP_CONFIG_ENCRYPTION_KEY).digest();return erpConfigKey}try{erpConfigKey=Buffer.from((await readFile(erpKeyPath,'utf8')).trim(),'hex')}catch{erpConfigKey=randomBytes(32);await writeFile(erpKeyPath,erpConfigKey.toString('hex'),{flag:'wx',mode:0o600}).catch(async error=>{if(error.code!=='EEXIST')throw error;erpConfigKey=Buffer.from((await readFile(erpKeyPath,'utf8')).trim(),'hex')})}if(erpConfigKey.length!==32)throw new Error('Chave de criptografia da conexão ERP inválida.');return erpConfigKey}
async function encryptErpSecrets(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await getErpConfigKey(),iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:encrypted.toString('hex')})}
async function decryptErpSecrets(value){if(!value)return {};const saved=JSON.parse(value),decipher=createDecipheriv('aes-256-gcm',await getErpConfigKey(),Buffer.from(saved.iv,'hex'));decipher.setAuthTag(Buffer.from(saved.tag,'hex'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data,'hex')),decipher.final()]).toString('utf8'))}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, erp_id TEXT UNIQUE, name TEXT NOT NULL,
    document TEXT, address TEXT DEFAULT '', address_number TEXT DEFAULT '', address_complement TEXT DEFAULT '', neighborhood TEXT DEFAULT '', postal_code TEXT DEFAULT '', city TEXT, state TEXT, email TEXT, phone TEXT,
    segment TEXT DEFAULT 'Varejo', status TEXT DEFAULT 'Ativo', notes TEXT DEFAULT '', visit_interval_days INTEGER NOT NULL DEFAULT 30,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, erp_id TEXT UNIQUE, sku TEXT NOT NULL,
    name TEXT NOT NULL, category TEXT, price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0, unit TEXT DEFAULT 'un', color TEXT DEFAULT '#dff3e9', image_url TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, erp_id TEXT, customer_id INTEGER NOT NULL,
    customer_name TEXT NOT NULL, seller TEXT DEFAULT 'Mariana Costa', status TEXT DEFAULT 'Rascunho',
    total REAL NOT NULL DEFAULT 0, items_json TEXT NOT NULL DEFAULT '[]', note TEXT DEFAULT '', idempotency_key TEXT UNIQUE,
    price_mode TEXT NOT NULL DEFAULT 'order', price_list_id INTEGER,
    payment_method TEXT NOT NULL DEFAULT '', payment_condition TEXT NOT NULL DEFAULT '',
    installment_count INTEGER NOT NULL DEFAULT 1, down_payment REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  );
  CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'seller', active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS customer_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
    seller TEXT NOT NULL, result TEXT NOT NULL DEFAULT 'Sem venda', notes TEXT DEFAULT '',
    visited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS visit_route_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, frequency TEXT NOT NULL DEFAULT 'once',
    visit_date TEXT NOT NULL, end_date TEXT, weekdays_json TEXT NOT NULL DEFAULT '[]', weeks_json TEXT NOT NULL DEFAULT '[]',
    assigned_user_id INTEGER NOT NULL, created_by_user_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Ativa',
    notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(assigned_user_id) REFERENCES users(id),
    FOREIGN KEY(created_by_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS visit_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER, title TEXT NOT NULL, visit_date TEXT NOT NULL,
    assigned_user_id INTEGER NOT NULL, created_by_user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'Planejada', notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(series_id) REFERENCES visit_route_series(id) ON DELETE CASCADE,
    FOREIGN KEY(assigned_user_id) REFERENCES users(id),
    FOREIGN KEY(created_by_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS visit_route_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT, route_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
    position INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Pendente', notes TEXT DEFAULT '',
    completed_at TEXT, UNIQUE(route_id,customer_id), UNIQUE(route_id,position),
    FOREIGN KEY(route_id) REFERENCES visit_routes(id) ON DELETE CASCADE,
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  );
  CREATE INDEX IF NOT EXISTS visit_routes_date_idx ON visit_routes(visit_date,status);
  CREATE TABLE IF NOT EXISTS price_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT, erp_id TEXT UNIQUE,
    name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS product_prices (
    product_id INTEGER NOT NULL, price_list_id INTEGER NOT NULL,
    price REAL NOT NULL CHECK(price >= 0),
    PRIMARY KEY(product_id,price_list_id),
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(price_list_id) REFERENCES price_lists(id)
  );
  CREATE TABLE IF NOT EXISTS erp_order_dispatches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL, price_list_id INTEGER NOT NULL,
    dispatch_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'Pendente',
    erp_order_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(order_id,price_list_id),
    FOREIGN KEY(order_id) REFERENCES orders(id),
    FOREIGN KEY(price_list_id) REFERENCES price_lists(id)
  );
`);

const customerColumns=db.prepare('PRAGMA table_info(customers)').all().map(column=>column.name);
if(!customerColumns.includes('visit_interval_days')) db.exec('ALTER TABLE customers ADD COLUMN visit_interval_days INTEGER NOT NULL DEFAULT 30');
if(!customerColumns.includes('assigned_user_id')) db.exec('ALTER TABLE customers ADD COLUMN assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
if(!customerColumns.includes('sales_blocked')) db.exec('ALTER TABLE customers ADD COLUMN sales_blocked INTEGER NOT NULL DEFAULT 0');
if(!customerColumns.includes('sales_block_reason')) db.exec("ALTER TABLE customers ADD COLUMN sales_block_reason TEXT NOT NULL DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS customers_assigned_user_idx ON customers(assigned_user_id,name)');
db.exec(`CREATE TABLE IF NOT EXISTS customer_portfolio_assignments (
  customer_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(customer_id,user_id),
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS customer_portfolio_user_idx ON customer_portfolio_assignments(user_id,customer_id);
INSERT OR IGNORE INTO customer_portfolio_assignments(customer_id,user_id)
  SELECT id,assigned_user_id FROM customers WHERE assigned_user_id IS NOT NULL;`);
db.exec(`CREATE TABLE IF NOT EXISTS sales_teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, manager_user_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(manager_user_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS sales_team_members (
  team_id INTEGER NOT NULL, user_id INTEGER NOT NULL UNIQUE,
  PRIMARY KEY(team_id,user_id),
  FOREIGN KEY(team_id) REFERENCES sales_teams(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sales_team_members_user_idx ON sales_team_members(user_id,team_id);`);
const productColumns=db.prepare('PRAGMA table_info(products)').all().map(column=>column.name);
if(!productColumns.includes('image_url')) db.exec("ALTER TABLE products ADD COLUMN image_url TEXT DEFAULT ''");
if(!productColumns.includes('cost_price')) db.exec('ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT NULL');
for(const [column,definition] of [['address',"TEXT DEFAULT ''"],['address_number',"TEXT DEFAULT ''"],['address_complement',"TEXT DEFAULT ''"],['neighborhood',"TEXT DEFAULT ''"],['postal_code',"TEXT DEFAULT ''"]])if(!customerColumns.includes(column))db.exec(`ALTER TABLE customers ADD COLUMN ${column} ${definition}`);
const routeColumns=db.prepare('PRAGMA table_info(visit_routes)').all().map(column=>column.name);
if(!routeColumns.includes('series_id')) db.exec('ALTER TABLE visit_routes ADD COLUMN series_id INTEGER REFERENCES visit_route_series(id) ON DELETE CASCADE');
db.exec('CREATE INDEX IF NOT EXISTS visit_routes_series_date_idx ON visit_routes(series_id,visit_date)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS visit_routes_series_date_unique ON visit_routes(series_id,visit_date) WHERE series_id IS NOT NULL');

const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(column => column.name);
if (!orderColumns.includes('idempotency_key')) db.exec('ALTER TABLE orders ADD COLUMN idempotency_key TEXT');
if (!orderColumns.includes('price_mode')) db.exec("ALTER TABLE orders ADD COLUMN price_mode TEXT NOT NULL DEFAULT 'order'");
if (!orderColumns.includes('price_list_id')) db.exec('ALTER TABLE orders ADD COLUMN price_list_id INTEGER');
if (!orderColumns.includes('payment_method')) db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''");
if (!orderColumns.includes('payment_condition')) db.exec("ALTER TABLE orders ADD COLUMN payment_condition TEXT NOT NULL DEFAULT ''");
if (!orderColumns.includes('installment_count')) db.exec('ALTER TABLE orders ADD COLUMN installment_count INTEGER NOT NULL DEFAULT 1');
if (!orderColumns.includes('down_payment')) db.exec('ALTER TABLE orders ADD COLUMN down_payment REAL NOT NULL DEFAULT 0');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL');
const eventClients = new Set();
const sessionDurationMs = 12 * 60 * 60 * 1000;
db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
const cookieName = 'fv_session';
const publicAuthRoutes = new Set(['/api/auth/status','/api/auth/setup','/api/auth/login']);
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, encoded) {
  if (!encoded?.includes(':')) return false;
  const [salt, key] = encoded.split(':');
  const expected = Buffer.from(key, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function publicUser(user) {
  return { id:user.id, name:user.name, email:user.email, role:user.role, active:Boolean(user.active), created_at:user.created_at };
}
function cookieToken(req) {
  const cookie = req.headers.cookie || '';
  const found = cookie.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${cookieName}=`));
  return found ? decodeURIComponent(found.slice(cookieName.length+1)) : '';
}
function issueSession(req,res,user) {
  const token=randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'),user.id,Date.now()+sessionDurationMs);
  const secure=process.env.NODE_ENV==='production'?'; Secure':'';
  res.setHeader('Set-Cookie',`${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDurationMs/1000}${secure}`);
}
function currentUser(req) {
  const token=cookieToken(req);
  if (!token) return null;
  const digest=createHash('sha256').update(token).digest('hex');
  const user=db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active,u.created_at FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(digest,Date.now());
  return user||null;
}
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value||'');
function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) {
    try { client.write(message); } catch { eventClients.delete(client); }
  }
}

const seeded = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('seeded');
if (!seeded) {
  const customer = db.prepare('INSERT INTO customers (erp_id,name,document,city,state,email,phone,segment,notes) VALUES (?,?,?,?,?,?,?,?,?)');
  [
    ['ERP-1042','Empório Santa Clara','12.345.678/0001-90','Campinas','SP','compras@santaclara.com.br','(19) 3344-2200','Mercearia','Prefere receber novidades às terças.'],
    ['ERP-1088','Mercado do Vale','45.882.110/0001-22','Jundiaí','SP','pedidos@mercadodovale.com.br','(11) 4588-1020','Supermercado',''],
    ['ERP-1116','Casa Verde Natural','08.721.095/0001-41','São Paulo','SP','contato@casaverde.com.br','(11) 3022-9090','Especializado','Interesse em linha sem açúcar.'],
    ['ERP-1193','Armazém Boa Praça','31.650.281/0001-07','Sorocaba','SP','financeiro@boapraca.com.br','(15) 3221-0003','Mercearia',''],
    ['ERP-1201','Supermais Central','72.090.553/0001-19','Santos','SP','compras@supermais.com.br','(13) 3233-7890','Supermercado','Revisar mix de produtos no próximo contato.'],
    ['ERP-1218','Empório das Flores','29.630.108/0001-50','Ribeirão Preto','SP','loja@emporiodasflores.com.br','(16) 3610-1234','Especializado','']
  ].forEach(row => customer.run(...row));
  const product = db.prepare('INSERT INTO products (erp_id,sku,name,category,price,stock,unit,color) VALUES (?,?,?,?,?,?,?,?)');
  [
    ['SKU-023','023','Café especial torrado 500g','Mercearia',32.9,184,'un','#efe7d7'],
    ['SKU-041','041','Azeite extra virgem 500ml','Mercearia',39.5,92,'un','#edf0d9'],
    ['SKU-076','076','Granola artesanal 300g','Natural',18.9,236,'un','#f4e5d6'],
    ['SKU-108','108','Suco integral uva 1L','Bebidas',14.5,64,'un','#f2dfe3'],
    ['SKU-132','132','Mel silvestre 250g','Natural',24.9,108,'un','#f5edcf'],
    ['SKU-209','209','Chá verde orgânico 20un','Bebidas',12.9,17,'cx','#dff0e7']
  ].forEach(row => product.run(...row));
  const customerIds = db.prepare('SELECT id,name FROM customers').all();
  const order = db.prepare('INSERT INTO orders (erp_id,customer_id,customer_name,seller,status,total,items_json,created_at) VALUES (?,?,?,?,?,?,?,?)');
  order.run('PED-24018',customerIds[0].id,customerIds[0].name,'Mariana Costa','Enviado ao ERP',842.4,JSON.stringify([{name:'Café especial torrado 500g',qty:12,price:32.9},{name:'Azeite extra virgem 500ml',qty:12,price:39.5}]),'2026-09-28 10:42:00');
  order.run('PED-24017',customerIds[1].id,customerIds[1].name,'Mariana Costa','Aprovado',1260,JSON.stringify([{name:'Granola artesanal 300g',qty:40,price:18.9},{name:'Suco integral uva 1L',qty:24,price:14.5}]),'2026-09-28 09:18:00');
  order.run('PED-24016',customerIds[2].id,customerIds[2].name,'Mariana Costa','Em análise',597.6,JSON.stringify([{name:'Mel silvestre 250g',qty:24,price:24.9}]),'2026-09-27 16:05:00');
  db.prepare('INSERT INTO app_meta (key,value) VALUES (?,?)').run('seeded','1');
}

if(!db.prepare('SELECT value FROM app_meta WHERE key=?').get('demo_product_costs_seeded')){
  const demoCosts=[['SKU-023',21.50],['SKU-041',27.00],['SKU-076',12.00],['SKU-108',9.20],['SKU-132',15.00],['SKU-209',8.40]];
  const updateDemoCost=db.prepare('UPDATE products SET cost_price=? WHERE erp_id=? AND cost_price IS NULL');
  for(const [erpId,cost] of demoCosts)updateDemoCost.run(cost,erpId);
  db.prepare('INSERT INTO app_meta (key,value) VALUES (?,?)').run('demo_product_costs_seeded','1');
}

// Keep the sample report internally consistent: order totals match their line items.
if(!db.prepare('SELECT value FROM app_meta WHERE key=?').get('demo_totals_reconciled')){
  const examples=db.prepare("SELECT id,items_json FROM orders WHERE erp_id IN ('PED-24018','PED-24017','PED-24016')").all();
  for(const example of examples){const total=JSON.parse(example.items_json||'[]').reduce((sum,item)=>sum+(Number(item.qty)||0)*(Number(item.price)||0),0);db.prepare('UPDATE orders SET total=? WHERE id=?').run(total,example.id)}
  db.prepare('INSERT INTO app_meta (key,value) VALUES (?,?)').run('demo_totals_reconciled','1');
}

if(!db.prepare('SELECT id FROM price_lists LIMIT 1').get()){
  const standard=db.prepare('INSERT INTO price_lists (erp_id,name,is_default) VALUES (?,?,?)').run('DEMO-PADRAO','Padrão (demonstração)',1).lastInsertRowid;
  const wholesale=db.prepare('INSERT INTO price_lists (erp_id,name) VALUES (?,?)').run('DEMO-ATACADO','Atacado (demonstração)').lastInsertRowid;
  const addPrice=db.prepare('INSERT INTO product_prices (product_id,price_list_id,price) VALUES (?,?,?)');
  for(const product of db.prepare('SELECT id,price FROM products').all()){
    addPrice.run(product.id,standard,product.price);
    addPrice.run(product.id,wholesale,Math.round(product.price*90)/100);
  }
}
const defaultPriceListId=db.prepare('SELECT id FROM price_lists WHERE is_default=1 AND active=1 ORDER BY id LIMIT 1').get()?.id;
if(defaultPriceListId) db.prepare('UPDATE orders SET price_list_id=? WHERE price_list_id IS NULL').run(defaultPriceListId);

async function getProjectSettings(){
  const row=db.prepare('SELECT value FROM app_meta WHERE key=?').get('project_settings');
  let saved={};
  try{saved=row?JSON.parse(row.value):{}}catch{}
  const secrets=await decryptErpSecrets(db.prepare('SELECT value FROM app_meta WHERE key=?').get('erp_connection_secrets')?.value);
  const activeList=Number(saved.operations?.defaultPriceListId)||defaultPriceListId||0;
  const {defaultPriceMode:_legacyPriceMode,...savedOperations}=saved.operations||{};
  return {
    erp:{environment:'homologacao',apiBaseUrl:process.env.ERP_API_URL||'',branchId:'',syncIntervalMinutes:30,tokenPath:'/token',...(saved.erp||{}),credentialsConfigured:Boolean(secrets.username&&secrets.password),tokenHeadersConfigured:Boolean(secrets.tokenHeaders&&Object.keys(secrets.tokenHeaders).length),usernameConfigured:Boolean(secrets.username)},
    operations:{defaultPriceListId:activeList,defaultVisitIntervalDays:30,...savedOperations},
    maps:{enabled:saved.maps?.enabled===true,googleEmbedApiKey:String(saved.maps?.googleEmbedApiKey||'')},
    updatedAt:saved.updatedAt||null
  };
}

const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(data)); };
async function body(req) {
  let raw = '';
  for await (const part of req) raw += part;
  return raw ? JSON.parse(raw) : {};
}
function listCustomers(search='', assignedUserId=null) {
  const assignmentClause=assignedUserId==null?'':' AND EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?)';
  const params=[`%${search}%`,`%${search}%`,`%${search}%`];
  if(assignedUserId!=null)params.push(assignedUserId);
  return db.prepare(`SELECT c.*,(SELECT GROUP_CONCAT(u.name, ', ') FROM customer_portfolio_assignments a JOIN users u ON u.id=a.user_id WHERE a.customer_id=c.id) assigned_seller_name,COUNT(o.id) order_count,COALESCE(SUM(o.total),0) total_bought,
      (SELECT MAX(v.visited_at) FROM customer_visits v WHERE v.customer_id=c.id) last_visit
    FROM customers c LEFT JOIN orders o ON o.customer_id=c.id
    WHERE (c.name LIKE ? OR c.city LIKE ? OR c.document LIKE ?)${assignmentClause}
    GROUP BY c.id ORDER BY c.name`).all(...params);
}
function canAccessCustomer(user,customerId){return user.role!=='seller'||Boolean(db.prepare('SELECT 1 FROM customer_portfolio_assignments WHERE customer_id=? AND user_id=?').get(Number(customerId),user.id))}
function canManageCustomerSales(user,customerId){if(user.role==='admin')return true;if(user.role!=='manager')return false;const team=db.prepare('SELECT id FROM sales_teams WHERE manager_user_id=?').get(user.id);if(!team)return false;return Boolean(db.prepare('SELECT 1 FROM customers c WHERE c.id=? AND (NOT EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id) OR EXISTS(SELECT 1 FROM customer_portfolio_assignments a JOIN sales_team_members tm ON tm.user_id=a.user_id WHERE a.customer_id=c.id AND tm.team_id=?))').get(Number(customerId),team.id))}
function localDateKey(date=new Date()){const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);return local.toISOString().slice(0,10)}
function addDaysToKey(key,days){const date=new Date(`${key}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10)}
function materializeVisitRouteSeries(seriesId,through){
  const series=db.prepare('SELECT * FROM visit_route_series WHERE id=?').get(seriesId);if(!series||series.status!=='Ativa')return;
  const dates=generateVisitRouteDates(series,through);if(!dates.length)return;
  let template=db.prepare('SELECT id FROM visit_routes WHERE series_id=? ORDER BY visit_date,id LIMIT 1').get(seriesId);
  if(!template)return;
  const stops=db.prepare('SELECT customer_id,position FROM visit_route_stops WHERE route_id=? ORDER BY position').all(template.id);
  const existing=db.prepare('SELECT visit_date FROM visit_routes WHERE series_id=?');
  const hasDate=new Set(existing.all(seriesId).map(row=>row.visit_date));
  const addRoute=db.prepare('INSERT INTO visit_routes (series_id,title,visit_date,assigned_user_id,created_by_user_id,notes) VALUES (?,?,?,?,?,?)');
  const addStop=db.prepare('INSERT INTO visit_route_stops (route_id,customer_id,position) VALUES (?,?,?)');
  for(const visitDate of dates){if(hasDate.has(visitDate))continue;const inserted=addRoute.run(seriesId,series.title,visitDate,series.assigned_user_id,series.created_by_user_id,series.notes);for(const stop of stops)addStop.run(inserted.lastInsertRowid,stop.customer_id,stop.position)}
}

const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin':'*', 'access-control-allow-methods':'GET,POST,PUT,PATCH,OPTIONS', 'access-control-allow-headers':'content-type' }); return res.end(); }
    if (url.pathname === '/api/health') return send(res,200,{ok:true,erpConfigured:Boolean((await getProjectSettings()).erp.apiBaseUrl)});
    if (url.pathname === '/api/auth/status' && req.method === 'GET') return send(res,200,{setupRequired:db.prepare('SELECT COUNT(*) count FROM users').get().count===0});
    if (url.pathname === '/api/auth/setup' && req.method === 'POST') {
      const b=await body(req),name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
      if(name.length<2||!validEmail(email)||password.length<10) return send(res,400,{error:'Informe nome, e-mail válido e senha com pelo menos 10 caracteres.'});
      db.exec('BEGIN IMMEDIATE');
      try {
        if(db.prepare('SELECT COUNT(*) count FROM users').get().count) { db.exec('ROLLBACK'); return send(res,409,{error:'A configuração inicial já foi concluída. Entre com sua conta.'}); }
        const result=db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')").run(name,email,hashPassword(password));
        db.exec('COMMIT');
        const user=db.prepare('SELECT id,name,email,role,active,created_at FROM users WHERE id=?').get(result.lastInsertRowid);
        issueSession(req,res,user);
        return send(res,201,{user:publicUser(user)});
      } catch(error) { db.exec('ROLLBACK'); throw error; }
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const b=await body(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
      const user=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
      if(!user||!verifyPassword(password,user.password_hash)) return send(res,401,{error:'E-mail ou senha incorretos.'});
      issueSession(req,res,user);
      return send(res,200,{user:publicUser(user)});
    }
    const user = url.pathname.startsWith('/api/') && !publicAuthRoutes.has(url.pathname) ? currentUser(req) : null;
    if (url.pathname.startsWith('/api/') && !publicAuthRoutes.has(url.pathname) && !user) return send(res,401,{error:'Sua sessão expirou. Entre novamente.'});
    if (url.pathname === '/api/auth/me' && req.method === 'GET') return send(res,200,{user:publicUser(user)});
    if(url.pathname==='/api/settings'&&req.method==='GET'){
      const settings=await getProjectSettings();
      if(user.role!=='admin') settings.erp={...settings.erp,apiBaseUrl:'',branchId:'',configured:Boolean(settings.erp.apiBaseUrl)};
      return send(res,200,settings);
    }
    if(url.pathname==='/api/settings'&&req.method==='PUT'){
      if(user.role!=='admin') return send(res,403,{error:'Somente administradores podem alterar as configurações.'});
      const b=await body(req),environment=String(b.erp?.environment||''),rawUrl=String(b.erp?.apiBaseUrl||'').trim(),branchId=String(b.erp?.branchId||'').trim(),syncIntervalMinutes=Number(b.erp?.syncIntervalMinutes),tokenPath=String(b.erp?.tokenPath||'/token').trim(),defaultPriceListId=Number(b.operations?.defaultPriceListId),defaultVisitIntervalDays=Number(b.operations?.defaultVisitIntervalDays);
      if(!['homologacao','producao'].includes(environment)) return send(res,400,{error:'Selecione homologação ou produção.'});
      if(rawUrl.length>2048) return send(res,400,{error:'O endereço da API é muito longo.'});
      if(rawUrl){try{const parsed=new URL(rawUrl);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)return send(res,400,{error:'Informe um endereço HTTP ou HTTPS válido, sem usuário, senha, parâmetros ou fragmento.'})}catch{return send(res,400,{error:'Informe um endereço válido para a API do ERP.'})}}
      if(branchId&&(!/^\d+$/.test(branchId)||Number(branchId)<1)) return send(res,400,{error:'O ID da filial deve ser um número inteiro positivo.'});
      if(!tokenPath.startsWith('/')||tokenPath.startsWith('//')||tokenPath.length>512||/[?#]/.test(tokenPath)) return send(res,400,{error:'Informe o caminho do endpoint de token começando com /.'});
      if(![5,15,30,60,360,720,1440].includes(syncIntervalMinutes)) return send(res,400,{error:'Selecione um intervalo de sincronização disponível.'});
      if(!db.prepare('SELECT id FROM price_lists WHERE id=? AND active=1').get(defaultPriceListId)) return send(res,400,{error:'Selecione uma lista de preços ativa.'});
      if(!Number.isInteger(defaultVisitIntervalDays)||defaultVisitIntervalDays<1||defaultVisitIntervalDays>365) return send(res,400,{error:'O prazo padrão de visita deve ficar entre 1 e 365 dias.'});
      const oldSecrets=await decryptErpSecrets(db.prepare('SELECT value FROM app_meta WHERE key=?').get('erp_connection_secrets')?.value);
      const username=String(b.erp?.username||'').trim(),password=String(b.erp?.password||'');
      let tokenHeaders=oldSecrets.tokenHeaders||{};
      if(b.erp?.tokenHeaders!==undefined){try{const parsed=JSON.parse(String(b.erp.tokenHeaders));if(!parsed||Array.isArray(parsed)||typeof parsed!=='object'||Object.entries(parsed).some(([key,val])=>!key.trim()||typeof val!=='string'||/[\r\n]/.test(key+val)))throw new Error();tokenHeaders=parsed}catch{return send(res,400,{error:'Os cabeçalhos da autenticação devem ser um objeto JSON com valores de texto.'})}}
      const nextSecrets={username:username||oldSecrets.username||'',password:password||oldSecrets.password||'',tokenHeaders};
      if(b.erp?.clearCredentials){nextSecrets.username='';nextSecrets.password='';nextSecrets.tokenHeaders={}}
      const googleEmbedApiKey=String(b.maps?.googleEmbedApiKey||'').trim()||String((await getProjectSettings()).maps.googleEmbedApiKey||'');
      if(googleEmbedApiKey.length>256||googleEmbedApiKey&&!/^[A-Za-z0-9_-]+$/.test(googleEmbedApiKey))return send(res,400,{error:'Confira a chave da API do Google Maps.'});
      const updated={erp:{environment,apiBaseUrl:rawUrl.replace(/\/+$/,''),branchId,syncIntervalMinutes,tokenPath},operations:{defaultPriceListId,defaultVisitIntervalDays},maps:{enabled:b.maps?.enabled===true,googleEmbedApiKey:b.maps?.clearApiKey?'':googleEmbedApiKey},updatedAt:new Date().toISOString()};
      db.prepare('INSERT INTO app_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('project_settings',JSON.stringify(updated));
      db.prepare('INSERT INTO app_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('erp_connection_secrets',await encryptErpSecrets(nextSecrets));
      return send(res,200,await getProjectSettings());
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token=cookieToken(req);
      if(token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(createHash('sha256').update(token).digest('hex'));
      const secure=process.env.NODE_ENV==='production'?'; Secure':'';
      res.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
      return send(res,200,{ok:true});
    }
    if (url.pathname === '/api/users' && req.method === 'GET') {
      if(user.role!=='admin') return send(res,403,{error:'Somente administradores podem gerenciar acessos.'});
      return send(res,200,db.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY name').all().map(publicUser));
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      if(user.role!=='admin') return send(res,403,{error:'Somente administradores podem gerenciar acessos.'});
      const b=await body(req),name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),role=String(b.role||'seller');
      if(name.length<2||!validEmail(email)||password.length<10||!['admin','manager','seller'].includes(role)) return send(res,400,{error:'Confira nome, e-mail, perfil e senha (mínimo de 10 caracteres).'});
      const result=db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)').run(name,email,hashPassword(password),role);
      broadcast('data-changed',{resource:'users',action:'created'});
      return send(res,201,publicUser(db.prepare('SELECT id,name,email,role,active,created_at FROM users WHERE id=?').get(result.lastInsertRowid)));
    }
    const userStatusMatch=url.pathname.match(/^\/api\/users\/(\d+)\/active$/);
    if(userStatusMatch&&req.method==='PATCH'){
      if(user.role!=='admin') return send(res,403,{error:'Somente administradores podem gerenciar acessos.'});
      const targetId=Number(userStatusMatch[1]),b=await body(req),active=b.active?1:0,target=db.prepare('SELECT id,role FROM users WHERE id=?').get(targetId);
      if(!target) return send(res,404,{error:'Usuário não encontrado.'});
      if(targetId===user.id&&!active) return send(res,400,{error:'Você não pode desativar sua própria conta.'});
      if(target.role==='admin'&&!active&&db.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND active=1").get().count<=1) return send(res,400,{error:'Mantenha ao menos um administrador ativo.'});
      db.prepare('UPDATE users SET active=? WHERE id=?').run(active,targetId);
      if(!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(targetId);
      broadcast('data-changed',{resource:'users',action:'updated'});
      return send(res,200,publicUser(db.prepare('SELECT id,name,email,role,active,created_at FROM users WHERE id=?').get(targetId)));
    }
    if(url.pathname==='/api/visit-route-assignees'&&req.method==='GET'){
      const assignees=db.prepare("SELECT id,name,role FROM users WHERE active=1 AND role IN ('admin','manager','seller') ORDER BY name").all();
      return send(res,200,user.role==='seller'?assignees.filter(person=>person.id===user.id):assignees);
    }
    if(url.pathname==='/api/visit-routes'&&req.method==='GET'){
      const horizon=addDaysToKey(localDateKey(),90),series=user.role==='seller'?db.prepare("SELECT id,visit_date FROM visit_route_series WHERE assigned_user_id=? AND status='Ativa' AND frequency!='once'").all(user.id):db.prepare("SELECT id,visit_date FROM visit_route_series WHERE status='Ativa' AND frequency!='once'").all();
      db.exec('BEGIN IMMEDIATE');try{for(const item of series){const through=addDaysToKey(item.visit_date,90);materializeVisitRouteSeries(item.id,through>horizon?through:horizon)}db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
      const routesSql=`SELECT r.*,u.name assigned_name,creator.name created_by_name,
        COUNT(s.id) stop_count,SUM(CASE WHEN s.status IN ('Visitado','Não visitado') THEN 1 ELSE 0 END) completed_count,
        COALESCE(rs.frequency,'once') frequency,rs.end_date,COALESCE(rs.weekdays_json,'[]') weekdays_json,COALESCE(rs.weeks_json,'[]') weeks_json,COALESCE(rs.status,'Ativa') series_status
        FROM visit_routes r JOIN users u ON u.id=r.assigned_user_id JOIN users creator ON creator.id=r.created_by_user_id
        LEFT JOIN visit_route_series rs ON rs.id=r.series_id
        LEFT JOIN visit_route_stops s ON s.route_id=r.id ${user.role==='seller'?'WHERE r.assigned_user_id=?':''}
        GROUP BY r.id ORDER BY r.visit_date DESC,r.id DESC`;
      const routes=user.role==='seller'?db.prepare(routesSql).all(user.id):db.prepare(routesSql).all();
      return send(res,200,routes);
    }
    if(url.pathname==='/api/visit-routes'&&req.method==='POST'){
      const b=await body(req),title=String(b.title||'').trim(),visitDate=String(b.visitDate||''),notes=String(b.notes||'').trim(),frequency=String(b.frequency||'once'),endDate=String(b.endDate||''),weekdays=Array.isArray(b.weekdays)?b.weekdays.map(Number):[],weeks=Array.isArray(b.weeks)?b.weeks.map(Number):[],requestedAssignee=Number(b.assignedUserId),assignedUserId=user.role==='seller'?user.id:(requestedAssignee||user.id),customerIds=Array.isArray(b.customerIds)?b.customerIds.map(Number):[];
      if(title.length<2||title.length>120)return send(res,400,{error:'Informe um nome de rota entre 2 e 120 caracteres.'});
      const validDateKey=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
      if(!validDateKey(visitDate)||visitDate<localDateKey())return send(res,400,{error:'Informe uma data válida igual ou posterior a hoje.'});
      if(!['once','weekly','monthly'].includes(frequency))return send(res,400,{error:'Selecione uma frequência válida para a rota.'});
      if(frequency!=='once'&&(!validDateKey(endDate)&&endDate||endDate&&endDate<visitDate))return send(res,400,{error:'Confira a data final da recorrência.'});
      if(endDate&&new Date(`${endDate}T00:00:00Z`).getTime()-new Date(`${visitDate}T00:00:00Z`).getTime()>5*366*86400000)return send(res,400,{error:'O período da recorrência não pode exceder 5 anos.'});
      if(frequency==='once'&&endDate&&endDate!==visitDate)return send(res,400,{error:'Uma rota avulsa utiliza apenas a data escolhida.'});
      if(frequency!=='once'&&(!weekdays.length||weekdays.some(day=>!Number.isInteger(day)||day<0||day>6)||new Set(weekdays).size!==weekdays.length))return send(res,400,{error:'Selecione ao menos um dia da semana para a recorrência.'});
      if(frequency==='monthly'&&(!weeks.length||weeks.some(week=>!Number.isInteger(week)||week<1||week>5)||new Set(weeks).size!==weeks.length))return send(res,400,{error:'Selecione ao menos uma semana do mês para a recorrência mensal.'});
      if(notes.length>2000)return send(res,400,{error:'As observações podem ter até 2.000 caracteres.'});
      if(!customerIds.length||customerIds.length>100||customerIds.some(id=>!Number.isInteger(id)||id<1)||new Set(customerIds).size!==customerIds.length)return send(res,400,{error:'Selecione de 1 a 100 clientes diferentes para a rota.'});
      if(user.role==='seller'){const owned=db.prepare(`SELECT COUNT(*) count FROM customers c WHERE c.id IN (${customerIds.map(()=>'?').join(',')}) AND EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?)`).get(...customerIds,user.id).count;if(owned!==customerIds.length)return send(res,403,{error:'A rota só pode conter clientes da sua carteira.'})}
      const assignee=db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(assignedUserId);
      if(!assignee)return send(res,400,{error:'O responsável selecionado não está ativo.'});
      if(user.role==='seller'&&assignedUserId!==user.id)return send(res,403,{error:'Vendedores só podem criar rotas para si mesmos.'});
      const findActiveCustomer=db.prepare("SELECT id FROM customers WHERE id=? AND COALESCE(status,'Ativo')!='Inativo'");
      if(customerIds.some(id=>!findActiveCustomer.get(id)))return send(res,400,{error:'Um ou mais clientes não existem ou estão inativos.'});
      const effectiveEnd=endDate||null,seedSeries={frequency,visit_date:visitDate,end_date:effectiveEnd,weekdays_json:JSON.stringify(frequency==='once'?[]:weekdays),weeks_json:JSON.stringify(frequency==='monthly'?weeks:[])},windowEnd=addDaysToKey(localDateKey(),90),generationThrough=effectiveEnd||([windowEnd,addDaysToKey(visitDate,90)].sort().at(-1)),occurrenceDates=generateVisitRouteDates(seedSeries,generationThrough);
      if(!occurrenceDates.length)return send(res,400,{error:'Nenhuma ocorrência dessa rota está dentro do período escolhido.'});
      if(occurrenceDates.length>500)return send(res,400,{error:'O período gera mais de 500 visitas; reduza a frequência ou a data final.'});
      db.exec('BEGIN IMMEDIATE');
      try{
        const createdSeries=db.prepare('INSERT INTO visit_route_series (title,frequency,visit_date,end_date,weekdays_json,weeks_json,assigned_user_id,created_by_user_id,notes) VALUES (?,?,?,?,?,?,?,?,?)').run(title,frequency,visitDate,effectiveEnd,seedSeries.weekdays_json,seedSeries.weeks_json,assignedUserId,user.id,notes),seriesId=Number(createdSeries.lastInsertRowid);
        const inserted=db.prepare('INSERT INTO visit_routes (series_id,title,visit_date,assigned_user_id,created_by_user_id,notes) VALUES (?,?,?,?,?,?)').run(seriesId,title,occurrenceDates[0],assignedUserId,user.id,notes);
        const addStop=db.prepare('INSERT INTO visit_route_stops (route_id,customer_id,position) VALUES (?,?,?)');
        customerIds.forEach((customerId,index)=>addStop.run(inserted.lastInsertRowid,customerId,index+1));
        materializeVisitRouteSeries(seriesId,generationThrough);
        db.exec('COMMIT');
        broadcast('data-changed',{resource:'visit_routes',action:'created',seriesId});
        return send(res,201,{id:Number(inserted.lastInsertRowid),seriesId,occurrenceCount:occurrenceDates.length});
      }catch(error){db.exec('ROLLBACK');throw error}
    }
    const routeSeriesMatch=url.pathname.match(/^\/api\/visit-route-series\/(\d+)$/);
    if(routeSeriesMatch&&req.method==='PATCH'){
      const seriesId=Number(routeSeriesMatch[1]),b=await body(req),status=String(b.status||''),series=db.prepare('SELECT * FROM visit_route_series WHERE id=?').get(seriesId);
      if(!series||user.role==='seller'&&series.assigned_user_id!==user.id)return send(res,404,{error:'Rota recorrente não encontrada.'});
      if(!['Ativa','Pausada'].includes(status))return send(res,400,{error:'Selecione ativar ou pausar a recorrência.'});
      db.prepare('UPDATE visit_route_series SET status=? WHERE id=?').run(status,seriesId);
      if(status==='Ativa')materializeVisitRouteSeries(seriesId,series.end_date||addDaysToKey(localDateKey(),90));
      broadcast('data-changed',{resource:'visit_routes',action:'series_updated',seriesId,status});
      return send(res,200,{id:seriesId,status});
    }
    const routeMatch=url.pathname.match(/^\/api\/visit-routes\/(\d+)$/);
    if(routeMatch&&req.method==='GET'){
      const routeId=Number(routeMatch[1]),route=db.prepare(`SELECT r.*,u.name assigned_name,creator.name created_by_name,COUNT(s.id) stop_count,
        COALESCE(rs.frequency,'once') frequency,rs.end_date,COALESCE(rs.weekdays_json,'[]') weekdays_json,COALESCE(rs.weeks_json,'[]') weeks_json,COALESCE(rs.status,'Ativa') series_status,
        SUM(CASE WHEN s.status IN ('Visitado','Não visitado') THEN 1 ELSE 0 END) completed_count
        FROM visit_routes r JOIN users u ON u.id=r.assigned_user_id JOIN users creator ON creator.id=r.created_by_user_id
        LEFT JOIN visit_route_series rs ON rs.id=r.series_id
        LEFT JOIN visit_route_stops s ON s.route_id=r.id WHERE r.id=? GROUP BY r.id`).get(routeId);
      if(!route||user.role==='seller'&&route.assigned_user_id!==user.id)return send(res,404,{error:'Rota não encontrada.'});
      const stops=db.prepare(`SELECT s.*,c.name customer_name,c.address,c.address_number,c.address_complement,c.neighborhood,c.postal_code,c.city,c.state,c.phone,c.document
        FROM visit_route_stops s JOIN customers c ON c.id=s.customer_id WHERE s.route_id=? ORDER BY s.position`).all(routeId);
      const occurrences=route.series_id?db.prepare('SELECT id,visit_date,status FROM visit_routes WHERE series_id=? ORDER BY visit_date,id').all(route.series_id):[{id:route.id,visit_date:route.visit_date,status:route.status}];
      return send(res,200,{...route,stops,occurrences});
    }
    if(routeMatch&&req.method==='PATCH'){
      const routeId=Number(routeMatch[1]),b=await body(req),route=db.prepare('SELECT * FROM visit_routes WHERE id=?').get(routeId);
      if(!route||user.role==='seller'&&route.assigned_user_id!==user.id)return send(res,404,{error:'Rota não encontrada.'});
      if(route.series_id&&db.prepare("SELECT status FROM visit_route_series WHERE id=?").get(route.series_id)?.status==='Pausada')return send(res,400,{error:'Reative a recorrência para alterar o status.'});
      if(!['Planejada','Em andamento','Concluída'].includes(b.status))return send(res,400,{error:'Selecione um status válido para a rota.'});
      db.prepare('UPDATE visit_routes SET status=? WHERE id=?').run(b.status,routeId);
      broadcast('data-changed',{resource:'visit_routes',action:'updated',routeId});
      return send(res,200,{id:routeId,status:b.status});
    }
    const routeStopMatch=url.pathname.match(/^\/api\/visit-routes\/(\d+)\/stops\/(\d+)$/);
    if(routeStopMatch&&req.method==='PATCH'){
      const routeId=Number(routeStopMatch[1]),stopId=Number(routeStopMatch[2]),b=await body(req),status=String(b.status||''),route=db.prepare('SELECT * FROM visit_routes WHERE id=?').get(routeId);
      if(!route||user.role==='seller'&&route.assigned_user_id!==user.id)return send(res,404,{error:'Rota não encontrada.'});
      if(route.series_id&&route.visit_date>localDateKey()&&db.prepare("SELECT status FROM visit_route_series WHERE id=?").get(route.series_id)?.status==='Pausada')return send(res,400,{error:'Esta recorrência está pausada; reative-a para alterar esta visita futura.'});
      if(!['Pendente','Visitado','Não visitado'].includes(status))return send(res,400,{error:'Selecione um resultado válido para a parada.'});
      const stop=db.prepare('SELECT * FROM visit_route_stops WHERE id=? AND route_id=?').get(stopId,routeId);
      if(!stop)return send(res,404,{error:'Cliente não encontrado nesta rota.'});
      const notes=String(b.notes||'').trim(),result=String(b.result||'Sem venda').trim();
      if(notes.length>2000||result.length>40)return send(res,400,{error:'Confira o resultado e as observações da visita.'});
      const completedAt=status==='Pendente'?null:new Date().toISOString();
      db.prepare('UPDATE visit_route_stops SET status=?,notes=?,completed_at=? WHERE id=?').run(status,notes,completedAt,stopId);
      if(status==='Visitado'&&stop.status!=='Visitado')db.prepare('INSERT INTO customer_visits (customer_id,seller,result,notes) VALUES (?,?,?,?)').run(stop.customer_id,user.name,result,notes);
      const pending=db.prepare("SELECT COUNT(*) count FROM visit_route_stops WHERE route_id=? AND status='Pendente'").get(routeId).count;
      const nextRouteStatus=pending===0?'Concluída':'Em andamento';
      db.prepare('UPDATE visit_routes SET status=? WHERE id=?').run(nextRouteStatus,routeId);
      broadcast('data-changed',{resource:'visit_routes',action:'stop_updated',routeId,stopId});
      return send(res,200,{id:stopId,status,routeStatus:nextRouteStatus});
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type':'text/event-stream; charset=utf-8', 'cache-control':'no-cache, no-transform', 'connection':'keep-alive', 'x-accel-buffering':'no' });
      res.write('retry: 3000\n\nevent: connected\ndata: {}\n\n');
      eventClients.add(res);
      const heartbeat=setInterval(()=>{ if (!res.destroyed) res.write(': keep-alive\n\n'); },25000);
      req.on('close',()=>{clearInterval(heartbeat);eventClients.delete(res)});
      return;
    }
    if (url.pathname === '/api/dashboard') {
      const totals=user.role==='seller'?db.prepare(`SELECT COUNT(*) orders,COALESCE(SUM(total),0) revenue FROM orders WHERE date(created_at)=date('now','localtime') AND customer_id IN (SELECT id FROM customers c WHERE EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?))`).get(user.id):db.prepare(`SELECT COUNT(*) orders,COALESCE(SUM(total),0) revenue FROM orders WHERE date(created_at)=date('now','localtime')`).get();
      const customers=user.role==='seller'?db.prepare('SELECT COUNT(*) count FROM customers c WHERE EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?)').get(user.id).count:db.prepare('SELECT COUNT(*) count FROM customers').get().count;
      const pending=user.role==='seller'?db.prepare("SELECT COUNT(*) count FROM orders WHERE status IN ('Rascunho','Em análise','Falha na integração') AND customer_id IN (SELECT id FROM customers c WHERE EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?))").get(user.id).count:db.prepare("SELECT COUNT(*) count FROM orders WHERE status IN ('Rascunho','Em análise','Falha na integração')").get().count;
      const recent=user.role==='seller'?db.prepare('SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id WHERE EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?) ORDER BY o.created_at DESC LIMIT 6').all(user.id):db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 6').all();
      return send(res,200,{...totals,customers,pending,recent});
    }
    if(url.pathname==='/api/reports'&&req.method==='GET'){
      const period=['7d','30d','90d','ytd'].includes(url.searchParams.get('period'))?url.searchParams.get('period'):'30d';
      const end=new Date();end.setHours(0,0,0,0);
      const start=new Date(end);
      if(period==='ytd') start.setMonth(0,1); else start.setDate(start.getDate()-({ '7d':6,'30d':29,'90d':89 }[period]));
      const spanDays=Math.round((end-start)/86400000)+1,previousEnd=new Date(start);previousEnd.setDate(previousEnd.getDate()-1);const previousStart=new Date(previousEnd);previousStart.setDate(previousStart.getDate()-spanDays+1);
      const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const currentRows=user.role==='seller'?db.prepare('SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id WHERE date(o.created_at) BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?) ORDER BY o.created_at DESC').all(iso(start),iso(end),user.id):db.prepare('SELECT * FROM orders WHERE date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC').all(iso(start),iso(end));
      const previous=user.role==='seller'?db.prepare('SELECT COUNT(*) orders,COALESCE(SUM(total),0) revenue FROM orders WHERE date(created_at) BETWEEN ? AND ? AND customer_id IN (SELECT id FROM customers c WHERE EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?))').get(iso(previousStart),iso(previousEnd),user.id):db.prepare('SELECT COUNT(*) orders,COALESCE(SUM(total),0) revenue FROM orders WHERE date(created_at) BETWEEN ? AND ?').get(iso(previousStart),iso(previousEnd));
      const revenue=currentRows.reduce((sum,o)=>sum+Number(o.total||0),0),ordersCount=currentRows.length;
      const customerSet=new Set(currentRows.map(o=>o.customer_id));
      const statuses=new Map(),clients=new Map(),productsMap=new Map(),salesMap=new Map();
      const monthMode=period==='ytd',weekMode=period==='90d';
      for(const order of currentRows){
        let bucket=monthMode?String(order.created_at).slice(0,7):String(order.created_at).slice(0,10);
        if(weekMode){const week=new Date(`${bucket}T12:00:00`);week.setDate(week.getDate()-(week.getDay()+6)%7);bucket=iso(week)}
        salesMap.set(bucket,(salesMap.get(bucket)||0)+Number(order.total||0));
        const status=statuses.get(order.status)||{status:order.status,orders:0,revenue:0};status.orders++;status.revenue+=Number(order.total||0);statuses.set(order.status,status);
        const client=clients.get(order.customer_id)||{name:order.customer_name,orders:0,revenue:0};client.orders++;client.revenue+=Number(order.total||0);clients.set(order.customer_id,client);
        try{for(const item of JSON.parse(order.items_json||'[]')){const key=item.productId||item.sku||item.name,p=productsMap.get(key)||{name:item.name||item.sku||'Produto',quantity:0,revenue:0};p.quantity+=Number(item.qty)||0;p.revenue+=Number(item.subtotal)||((Number(item.qty)||0)*(Number(item.price)||0));productsMap.set(key,p)}}catch{}
      }
      const salesSeries=[];
      if(monthMode){for(let month=0;month<=end.getMonth();month++){const key=`${end.getFullYear()}-${String(month+1).padStart(2,'0')}`;salesSeries.push({date:key,label:new Intl.DateTimeFormat('pt-BR',{month:'short'}).format(new Date(end.getFullYear(),month,1)).replace('.',''),revenue:salesMap.get(key)||0})}}
      else if(weekMode){const firstWeek=new Date(start);firstWeek.setDate(firstWeek.getDate()-(firstWeek.getDay()+6)%7);for(let week=new Date(firstWeek);week<=end;week.setDate(week.getDate()+7)){const key=iso(week);salesSeries.push({date:key,label:new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short'}).format(week).replace('.',''),revenue:salesMap.get(key)||0})}}
      else{for(let day=new Date(start);day<=end;day.setDate(day.getDate()+1)){const key=iso(day);salesSeries.push({date:key,label:new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short'}).format(day).replace('.',''),revenue:salesMap.get(key)||0})}}
      return send(res,200,{period,startDate:iso(start),endDate:iso(end),summary:{orders:ordersCount,revenue,averageTicket:ordersCount?revenue/ordersCount:0,customers:customerSet.size,previousOrders:previous.orders,previousRevenue:previous.revenue,revenueChangePct:previous.revenue?(revenue-previous.revenue)/previous.revenue*100:null,ordersChangePct:previous.orders?(ordersCount-previous.orders)/previous.orders*100:null},orders:currentRows.map(({id,erp_id,customer_name,status,total,created_at})=>({id,erp_id,customer_name,status,total,created_at})),salesSeries,statuses:[...statuses.values()].sort((a,b)=>b.revenue-a.revenue),topCustomers:[...clients.values()].sort((a,b)=>b.revenue-a.revenue).slice(0,10),topProducts:[...productsMap.values()].sort((a,b)=>b.revenue-a.revenue).slice(0,10)});
    }
    if(url.pathname==='/api/teams'&&(req.method==='GET'||req.method==='PUT')){
      if(req.method==='GET'){
        if(!['admin','manager'].includes(user.role))return send(res,403,{error:'Somente gestores e administradores podem consultar equipes.'});
        const where=user.role==='manager'?'WHERE t.manager_user_id=?':'';
        const teams=db.prepare(`SELECT t.id,t.name,t.manager_user_id,m.name manager_name,(SELECT GROUP_CONCAT(stm.user_id) FROM sales_team_members stm WHERE stm.team_id=t.id) seller_ids,(SELECT GROUP_CONCAT(u.name, ' · ') FROM sales_team_members stm JOIN users u ON u.id=stm.user_id WHERE stm.team_id=t.id) seller_names FROM sales_teams t JOIN users m ON m.id=t.manager_user_id ${where} ORDER BY t.name`).all(...(user.role==='manager'?[user.id]:[])).map(row=>({...row,seller_ids:row.seller_ids?row.seller_ids.split(',').map(Number):[]}));
        if(user.role==='manager')return send(res,200,{teams,managers:[],sellers:[]});
        const managers=db.prepare("SELECT id,name,active FROM users WHERE role='manager' ORDER BY active DESC,name").all().map(row=>({...row,active:Boolean(row.active)}));
        const sellers=db.prepare("SELECT u.id,u.name,u.active,(SELECT t.name FROM sales_team_members stm JOIN sales_teams t ON t.id=stm.team_id WHERE stm.user_id=u.id) team_name,(SELECT team_id FROM sales_team_members WHERE user_id=u.id) team_id FROM users u WHERE u.role='seller' ORDER BY u.active DESC,u.name").all().map(row=>({...row,active:Boolean(row.active)}));
        return send(res,200,{teams,managers,sellers});
      }
      if(user.role!=='admin')return send(res,403,{error:'Somente administradores podem configurar equipes.'});
      const b=await body(req),teamId=b.teamId?Number(b.teamId):null,name=String(b.name||'').trim(),managerId=Number(b.managerId),sellerIds=Array.isArray(b.sellerIds)?b.sellerIds.map(Number):[];
      if(name.length<2||name.length>100||!Number.isInteger(managerId)||managerId<1||!sellerIds.length||sellerIds.some(id=>!Number.isInteger(id)||id<1)||new Set(sellerIds).size!==sellerIds.length)return send(res,400,{error:'Informe o nome da equipe, um gestor e ao menos um vendedor.'});
      if(teamId!==null&&(!Number.isInteger(teamId)||teamId<1||!db.prepare('SELECT id FROM sales_teams WHERE id=?').get(teamId)))return send(res,404,{error:'Equipe não encontrada.'});
      if(!db.prepare("SELECT id FROM users WHERE id=? AND role='manager' AND active=1").get(managerId))return send(res,400,{error:'Selecione um gestor ativo.'});
      if(db.prepare('SELECT id FROM sales_teams WHERE manager_user_id=? AND id!=COALESCE(?,0)').get(managerId,teamId))return send(res,400,{error:'Este gestor já está vinculado a outra equipe.'});
      for(const sellerId of sellerIds){
        if(!db.prepare("SELECT id FROM users WHERE id=? AND role='seller' AND (active=1 OR id IN (SELECT user_id FROM sales_team_members WHERE team_id=COALESCE(?,0)))").get(sellerId,teamId))return send(res,400,{error:'Selecione vendedores válidos para a equipe.'});
        if(db.prepare('SELECT team_id FROM sales_team_members WHERE user_id=? AND team_id!=COALESCE(?,0)').get(sellerId,teamId))return send(res,400,{error:'Um vendedor selecionado já pertence a outra equipe.'});
      }
      db.exec('BEGIN IMMEDIATE');let savedId=teamId;
      try{
        if(savedId===null)savedId=Number(db.prepare('INSERT INTO sales_teams(name,manager_user_id) VALUES(?,?)').run(name,managerId).lastInsertRowid);
        else db.prepare("UPDATE sales_teams SET name=?,manager_user_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name,managerId,savedId);
        db.prepare('DELETE FROM sales_team_members WHERE team_id=?').run(savedId);
        const addMember=db.prepare('INSERT INTO sales_team_members(team_id,user_id) VALUES(?,?)');for(const sellerId of sellerIds)addMember.run(savedId,sellerId);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');if(String(error.message).includes('UNIQUE'))return send(res,400,{error:'O nome, gestor ou vendedor já está vinculado a outra equipe.'});throw error}
      broadcast('data-changed',{resource:'teams',action:teamId===null?'created':'updated',teamId:savedId});
      return send(res,200,{teamId:savedId});
    }
    if(url.pathname==='/api/customer-portfolio'&&(req.method==='GET'||req.method==='PUT')){
      if(!['admin','manager'].includes(user.role))return send(res,403,{error:'Somente gestores e administradores podem gerenciar as carteiras.'});
      const managedTeam=user.role==='manager'?db.prepare('SELECT id FROM sales_teams WHERE manager_user_id=?').get(user.id):null;
      if(user.role==='manager'&&!managedTeam)return send(res,403,{error:'Sua conta ainda não está vinculada a uma equipe.'});
      const teamId=managedTeam?.id||null,teamSellerIds=user.role==='manager'?db.prepare('SELECT user_id FROM sales_team_members WHERE team_id=?').all(teamId).map(row=>Number(row.user_id)):null;
      const customerScope=user.role==='manager'?' AND (NOT EXISTS(SELECT 1 FROM customer_portfolio_assignments ax WHERE ax.customer_id=c.id) OR EXISTS(SELECT 1 FROM customer_portfolio_assignments ax JOIN sales_team_members tm ON tm.user_id=ax.user_id WHERE ax.customer_id=c.id AND tm.team_id=?))':'';
      if(req.method==='GET'){
        const search=String(url.searchParams.get('search')||'').trim().slice(0,120),sellerFilter=String(url.searchParams.get('seller')||'all'),page=Math.min(1000000,Math.max(0,Number.parseInt(url.searchParams.get('page')||'0',10)||0)),pageSize=100,offset=page*pageSize;
        let filterSql='';const filterParams=[];
        if(sellerFilter==='unassigned')filterSql=' AND NOT EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id)';
        else if(sellerFilter!=='all'){
          const sellerId=Number(sellerFilter);
          if(!Number.isInteger(sellerId)||sellerId<1||(teamSellerIds&&!teamSellerIds.includes(sellerId)))return send(res,400,{error:'Selecione um vendedor da equipe.'});
          filterSql=' AND EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?)';filterParams.push(sellerId);
        }
        const pattern=`%${search}%`,scopeParams=teamId===null?[]:[teamId],baseParams=[pattern,pattern,pattern,...scopeParams,...filterParams];
        const total=Number(db.prepare(`SELECT COUNT(*) count FROM customers c WHERE (c.name LIKE ? OR c.city LIKE ? OR c.document LIKE ?)${customerScope}${filterSql}`).get(...baseParams).count);
        const assignmentScope=teamId===null?'':' AND a.user_id IN (SELECT user_id FROM sales_team_members WHERE team_id=?)',assignmentParams=teamId===null?[]:[teamId];
        const customers=db.prepare(`SELECT c.id,c.name,c.document,c.city,c.state,(SELECT GROUP_CONCAT(a.user_id) FROM customer_portfolio_assignments a WHERE a.customer_id=c.id${assignmentScope}) assigned_user_ids FROM customers c WHERE (c.name LIKE ? OR c.city LIKE ? OR c.document LIKE ?)${customerScope}${filterSql} ORDER BY c.name LIMIT ? OFFSET ?`).all(...assignmentParams,...baseParams,pageSize,offset).map(row=>({...row,assigned_user_ids:row.assigned_user_ids?row.assigned_user_ids.split(',').map(Number):[]}));
        const sellerSql=user.role==='manager'?"SELECT u.id,u.name,u.active,(SELECT COUNT(*) FROM customer_portfolio_assignments a WHERE a.user_id=u.id) customer_count FROM users u JOIN sales_team_members tm ON tm.user_id=u.id WHERE u.role='seller' AND tm.team_id=? ORDER BY u.active DESC,u.name":"SELECT u.id,u.name,u.active,(SELECT COUNT(*) FROM customer_portfolio_assignments a WHERE a.user_id=u.id) customer_count FROM users u WHERE u.role='seller' ORDER BY u.active DESC,u.name";
        const sellers=db.prepare(sellerSql).all(...(teamId===null?[]:[teamId])).map(row=>({...row,active:Boolean(row.active)}));
        const unassignedCount=Number(db.prepare(`SELECT COUNT(*) count FROM customers c WHERE NOT EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id)${teamId===null?'': ' AND '+customerScope.trim().replace(/^AND /,'')}`).get(...scopeParams).count);
        const allCount=teamId===null?Number(db.prepare('SELECT COUNT(*) count FROM customers').get().count):Number(db.prepare(`SELECT COUNT(*) count FROM customers c WHERE (NOT EXISTS(SELECT 1 FROM customer_portfolio_assignments ax WHERE ax.customer_id=c.id) OR EXISTS(SELECT 1 FROM customer_portfolio_assignments ax JOIN sales_team_members tm ON tm.user_id=ax.user_id WHERE ax.customer_id=c.id AND tm.team_id=?))`).get(teamId).count);
        const team=teamId===null?null:db.prepare('SELECT id,name FROM sales_teams WHERE id=?').get(teamId);
        return send(res,200,{customers,sellers,total,page,pageSize,unassignedCount,allCount,team});
      }
      const b=await body(req),assignments=Array.isArray(b.assignments)?b.assignments:[];
      if(!assignments.length||assignments.length>5000)return send(res,400,{error:'Envie de 1 a 5.000 alterações de carteira por vez.'});
      const seen=new Set(),normalized=[];
      for(const item of assignments){
        const customerId=Number(item?.customerId),sellerIds=item?.sellerIds;
        if(!Number.isInteger(customerId)||customerId<1||seen.has(customerId)||!Array.isArray(sellerIds)||sellerIds.some(id=>!Number.isInteger(Number(id))||Number(id)<1)||new Set(sellerIds.map(Number)).size!==sellerIds.length)return send(res,400,{error:'Há uma atribuição inválida ou duplicada.'});
        if(!db.prepare('SELECT id FROM customers WHERE id=?').get(customerId))return send(res,404,{error:'Um dos clientes não foi encontrado.'});
        if(teamSellerIds){const canManage=db.prepare('SELECT 1 FROM customers c WHERE c.id=? AND (NOT EXISTS(SELECT 1 FROM customer_portfolio_assignments ax WHERE ax.customer_id=c.id) OR EXISTS(SELECT 1 FROM customer_portfolio_assignments ax JOIN sales_team_members tm ON tm.user_id=ax.user_id WHERE ax.customer_id=c.id AND tm.team_id=?))').get(customerId,teamId);if(!canManage)return send(res,403,{error:'Este cliente pertence a outra equipe.'})}
        const ids=[...new Set(sellerIds.map(Number))];
        for(const sellerId of ids){if(teamSellerIds&&!teamSellerIds.includes(sellerId))return send(res,403,{error:'Só é possível vincular vendedores da sua equipe.'});if(!db.prepare("SELECT id FROM users WHERE id=? AND role='seller' AND (active=1 OR EXISTS(SELECT 1 FROM customer_portfolio_assignments WHERE customer_id=? AND user_id=?))").get(sellerId,customerId,sellerId))return send(res,400,{error:'Novos vínculos só podem ser feitos com vendedores ativos.'})}
        seen.add(customerId);normalized.push({customerId,sellerIds:ids});
      }
      const insert=db.prepare('INSERT OR IGNORE INTO customer_portfolio_assignments(customer_id,user_id) VALUES(?,?)'),mirror=db.prepare('UPDATE customers SET assigned_user_id=(SELECT CASE WHEN COUNT(*)=1 THEN MIN(user_id) ELSE NULL END FROM customer_portfolio_assignments WHERE customer_id=?) WHERE id=?');
      db.exec('BEGIN IMMEDIATE');try{for(const item of normalized){if(!teamSellerIds)db.prepare('DELETE FROM customer_portfolio_assignments WHERE customer_id=?').run(item.customerId);else db.prepare('DELETE FROM customer_portfolio_assignments WHERE customer_id=? AND user_id IN (SELECT user_id FROM sales_team_members WHERE team_id=?)').run(item.customerId,teamId);for(const sellerId of item.sellerIds)insert.run(item.customerId,sellerId);mirror.run(item.customerId,item.customerId)}db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
      broadcast('data-changed',{resource:'customer_portfolio',action:'updated',count:normalized.length});
      return send(res,200,{updated:normalized.length});
    }
    if (url.pathname === '/api/customers' && req.method === 'GET') return send(res,200,listCustomers(url.searchParams.get('search')||'',user.role==='seller'?user.id:null));
    if (url.pathname === '/api/customers' && req.method === 'POST') {
      const b = await body(req);
      if (!b.name?.trim()) return send(res,400,{error:'Informe o nome do cliente.'});
      const result = db.prepare('INSERT INTO customers (name,document,address,address_number,address_complement,neighborhood,postal_code,city,state,email,phone,segment,notes,visit_interval_days,assigned_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(b.name.trim(),b.document||'',b.address||'',b.addressNumber||'',b.addressComplement||'',b.neighborhood||'',b.postalCode||'',b.city||'',b.state||'SP',b.email||'',b.phone||'',b.segment||'Varejo',b.notes||'',(await getProjectSettings()).operations.defaultVisitIntervalDays,user.role==='seller'?user.id:null);
      if(user.role==='seller')db.prepare('INSERT OR IGNORE INTO customer_portfolio_assignments(customer_id,user_id) VALUES(?,?)').run(result.lastInsertRowid,user.id);
      const customer=db.prepare('SELECT * FROM customers WHERE id=?').get(result.lastInsertRowid);
      broadcast('data-changed',{resource:'customers',action:'created'});
      return send(res,201,customer);
    }
    const salesBlockMatch=url.pathname.match(/^\/api\/customers\/(\d+)\/sales-block$/);
    if(salesBlockMatch&&req.method==='PATCH'){
      if(!['admin','manager'].includes(user.role))return send(res,403,{error:'Somente gestores e administradores podem controlar bloqueios de venda.'});
      const customerId=Number(salesBlockMatch[1]),b=await body(req),blocked=b.blocked===true,reason=blocked?String(b.reason||'Bloqueado manualmente pela equipe.').trim().slice(0,500):'';
      if(!canManageCustomerSales(user,customerId))return send(res,404,{error:'Cliente não encontrado na sua equipe.'});
      const result=db.prepare('UPDATE customers SET sales_blocked=?,sales_block_reason=? WHERE id=?').run(blocked?1:0,reason,customerId);
      if(!result.changes)return send(res,404,{error:'Cliente não encontrado.'});
      broadcast('data-changed',{resource:'customers',customerId,action:blocked?'sales_blocked':'sales_unblocked'});
      return send(res,200,db.prepare('SELECT id,sales_blocked,sales_block_reason FROM customers WHERE id=?').get(customerId));
    }
    const customerVisitMatch=url.pathname.match(/^\/api\/customers\/(\d+)\/visits$/);
    if(customerVisitMatch&&req.method==='GET'){
      const customerId=Number(customerVisitMatch[1]);
      if(!canAccessCustomer(user,customerId)) return send(res,404,{error:'Cliente não encontrado.'});
      return send(res,200,db.prepare('SELECT * FROM customer_visits WHERE customer_id=? ORDER BY visited_at DESC,id DESC').all(customerId));
    }
    if(customerVisitMatch&&req.method==='POST'){
      const customerId=Number(customerVisitMatch[1]),client=db.prepare('SELECT id FROM customers WHERE id=?').get(customerId);
      if(!client||!canAccessCustomer(user,customerId)) return send(res,404,{error:'Cliente não encontrado.'});
      const b=await body(req),notes=String(b.notes||'').trim();
      if(notes.length>2000) return send(res,400,{error:'A observação deve ter até 2.000 caracteres.'});
      const result=db.prepare('INSERT INTO customer_visits (customer_id,seller,result,notes) VALUES (?,?,?,?)').run(customerId,user.name,String(b.result||'Sem venda').slice(0,40),notes);
      const visit=db.prepare('SELECT * FROM customer_visits WHERE id=?').get(result.lastInsertRowid);
      broadcast('data-changed',{resource:'customer_visits',customerId,action:'created'});
      return send(res,201,visit);
    }
    const customerVisitIntervalMatch=url.pathname.match(/^\/api\/customers\/(\d+)\/visit-interval$/);
    if(customerVisitIntervalMatch&&req.method==='PATCH'){
      const customerId=Number(customerVisitIntervalMatch[1]),b=await body(req),days=Number(b.days);
      if(!canAccessCustomer(user,customerId))return send(res,404,{error:'Cliente não encontrado.'});
      if(!Number.isInteger(days)||days<1||days>365) return send(res,400,{error:'O prazo deve ser entre 1 e 365 dias.'});
      const result=db.prepare('UPDATE customers SET visit_interval_days=? WHERE id=?').run(days,customerId);
      if(!result.changes) return send(res,404,{error:'Cliente não encontrado.'});
      broadcast('data-changed',{resource:'customers',customerId,action:'visit_interval_updated'});
      return send(res,200,db.prepare('SELECT id,visit_interval_days FROM customers WHERE id=?').get(customerId));
    }
    if (url.pathname === '/api/price-lists' && req.method === 'GET') return send(res,200,db.prepare('SELECT id,erp_id,name,is_default,active FROM price_lists WHERE active=1 ORDER BY is_default DESC,name').all());
    if (url.pathname === '/api/products' && req.method === 'GET') {
      const rows=db.prepare('SELECT * FROM products WHERE name LIKE ? OR sku LIKE ? ORDER BY name').all(`%${url.searchParams.get('search')||''}%`,`%${url.searchParams.get('search')||''}%`);
      const prices=db.prepare('SELECT product_id,price_list_id,price FROM product_prices').all();
      return send(res,200,rows.map(product=>({...product,prices:prices.filter(row=>row.product_id===product.id)})));
    }
    if (url.pathname === '/api/orders' && req.method === 'GET') return send(res,200,user.role==='seller'?db.prepare('SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id WHERE EXISTS(SELECT 1 FROM customer_portfolio_assignments a WHERE a.customer_id=c.id AND a.user_id=?) ORDER BY o.created_at DESC').all(user.id):db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all());
    const erpPreviewMatch=url.pathname.match(/^\/api\/orders\/(\d+)\/erp-preview$/);
    if(erpPreviewMatch&&req.method==='GET'){
      const order=db.prepare('SELECT * FROM orders WHERE id=?').get(Number(erpPreviewMatch[1]));
      if(!order||!canAccessCustomer(user,order.customer_id)) return send(res,404,{error:'Pedido não encontrado.'});
      const customer=db.prepare('SELECT id,erp_id FROM customers WHERE id=?').get(order.customer_id);
      const lists=db.prepare('SELECT id,erp_id,name FROM price_lists').all();
      const items=JSON.parse(order.items_json||'[]');
      const groups=buildErpDispatchPlan(order,customer,items,lists);
      const dispatches=db.prepare('SELECT price_list_id,dispatch_key,status,erp_order_id FROM erp_order_dispatches WHERE order_id=? ORDER BY id').all(order.id);
      return send(res,200,{localOrderId:order.id,priceMode:order.price_mode,groupCount:groups.length,requiresSplit:groups.length>1,groups,dispatches,adapterConfigured:false,message:'Plano de envio: um único pedido, com o preço selecionado em cada item.'});
    }
    if (url.pathname === '/api/orders' && req.method === 'POST') {
      const b = await body(req);
      if (b.idempotencyKey) {
        const existing=db.prepare('SELECT * FROM orders WHERE idempotency_key=?').get(String(b.idempotencyKey).slice(0,100));
        if (existing) return send(res,200,existing);
      }
      const client = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(b.customerId));
      if (!client) return send(res,400,{error:'Selecione um cliente válido.'});
      if(!canAccessCustomer(user,client.id))return send(res,403,{error:'Este cliente não pertence à sua carteira.'});
      if(client.sales_blocked)return send(res,403,{error:client.sales_block_reason||'Este cliente está bloqueado para novos pedidos.'});
      if (!Array.isArray(b.items)||!b.items.length) return send(res,400,{error:'Adicione pelo menos um produto ao pedido.'});
      const priceMode='item';
      const headerListId=Number(b.priceListId||defaultPriceListId);
      if(!db.prepare('SELECT id FROM price_lists WHERE id=? AND active=1').get(headerListId)) return send(res,400,{error:'Selecione uma lista de preços válida para o pedido.'});
      const items=b.items.map(item=>{
        const product=db.prepare('SELECT id,name,sku,cost_price FROM products WHERE id=?').get(Number(item.productId));
        if(!product) throw new Error('Um dos produtos não foi encontrado.');
        const qty=Number(item.qty),listId=Number(item.priceListId||headerListId);
        if(!Number.isInteger(qty)||qty<1) throw new Error('Informe uma quantidade inteira maior que zero.');
        const rate=db.prepare(`SELECT pp.price,pl.erp_id price_list_erp_id,pl.name price_list_name
          FROM product_prices pp JOIN price_lists pl ON pl.id=pp.price_list_id
          WHERE pp.product_id=? AND pp.price_list_id=? AND pl.active=1`).get(product.id,listId);
        if(!rate) throw new Error(`O produto ${product.name} não tem preço na lista escolhida.`);
        const adjustmentType=String(item.adjustmentType||'none');
        if(!['none','discount','surcharge'].includes(adjustmentType))throw new Error('Tipo de ajuste inválido.');
        const adjustmentMode=String(item.adjustmentMode||'amount');
        if(!['amount','percent'].includes(adjustmentMode))throw new Error('Formato de ajuste inválido.');
        const rawAdjustment=Number(item.adjustmentValue||0);
        if(!Number.isFinite(rawAdjustment)||rawAdjustment<0||rawAdjustment>1000000||adjustmentMode==='percent'&&rawAdjustment>100)throw new Error('Informe um valor válido para o ajuste por unidade.');
        const adjustmentValue=adjustmentType==='none'?0:Math.round(rawAdjustment*100)/100;
        const change=adjustmentMode==='percent'?Math.round(Number(rate.price)*adjustmentValue)/100:adjustmentValue;
        if(adjustmentType==='discount'&&change>rate.price)throw new Error('O desconto por unidade não pode superar o preço unitário.');
        const price=Math.round((Number(rate.price)+(adjustmentType==='discount'?-change:adjustmentType==='surcharge'?change:0))*100)/100;
        return {productId:product.id,name:product.name,sku:product.sku,qty,priceListId:listId,
          priceListErpId:rate.price_list_erp_id,priceListName:rate.price_list_name,
          basePrice:rate.price,costPrice:product.cost_price,adjustmentType,adjustmentMode,adjustmentValue,price,subtotal:Math.round(qty*price*100)/100};
      });
      const total=Math.round(items.reduce((sum,item)=>sum+item.subtotal,0)*100)/100;
      const allowedPaymentMethods=['pix','dinheiro','cartao_debito','cartao_credito','boleto','transferencia','faturado','a_combinar','outro'];
      const paymentMethod=String(b.paymentMethod||'').trim(),paymentCondition=String(b.paymentCondition||'').trim().slice(0,120);
      const termPaymentMethods=['cartao_credito','boleto','faturado'];
      const installmentCount=Number(b.installmentCount??1),downPayment=Math.round(Number(b.downPayment??0)*100)/100;
      if(!allowedPaymentMethods.includes(paymentMethod))return send(res,400,{error:'Selecione um meio de pagamento válido.'});
      if(termPaymentMethods.includes(paymentMethod)&&(!Number.isInteger(installmentCount)||installmentCount<1||installmentCount>36))return send(res,400,{error:'A quantidade de parcelas deve ser entre 1 e 36.'});
      if(!Number.isFinite(downPayment)||downPayment<0||downPayment>total)return send(res,400,{error:'O valor de entrada deve estar entre zero e o total do pedido.'});
      if(!termPaymentMethods.includes(paymentMethod)&&(installmentCount!==1||downPayment!==0))return send(res,400,{error:'Parcelas e entrada só podem ser informadas para pagamentos a prazo.'});
      db.exec('BEGIN IMMEDIATE');
      let order;
      try {
        const result=db.prepare('INSERT INTO orders (customer_id,customer_name,seller,status,total,items_json,note,idempotency_key,price_mode,price_list_id,payment_method,payment_condition,installment_count,down_payment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(client.id,client.name,user.name,'Rascunho',total,JSON.stringify(items),b.note||'',b.idempotencyKey?String(b.idempotencyKey).slice(0,100):null,priceMode,headerListId,paymentMethod,paymentCondition,termPaymentMethods.includes(paymentMethod)?installmentCount:1,termPaymentMethods.includes(paymentMethod)?downPayment:0);
        order=db.prepare('SELECT * FROM orders WHERE id=?').get(result.lastInsertRowid);
        const addDispatch=db.prepare('INSERT INTO erp_order_dispatches (order_id,price_list_id,dispatch_key) VALUES (?,?,?)');
        addDispatch.run(order.id,headerListId,`order-${order.id}`);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      broadcast('data-changed',{resource:'orders',action:'created'});
      return send(res,201,order);
    }
    if (url.pathname.startsWith('/api/')) return send(res,404,{error:'Rota não encontrada.'});
    const path = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^([\\/])+/, '');
    const file = join(publicDir,path);
    if (!file.startsWith(publicDir)) return send(res,403,{error:'Acesso negado.'});
    const content = await readFile(file);
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
    res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'}); res.end(content);
  } catch (error) {
    const status=error.code==='SQLITE_CONSTRAINT_UNIQUE'?409:400;
    if (!res.headersSent) send(res,status,{error:error.message||'Não foi possível concluir a operação.'});
  }
});

const port=Number(process.env.PORT)||3000;
server.listen(port,()=>console.log(`Força de Vendas disponível em http://localhost:${port}`));
