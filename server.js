const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken'); // Para autenticação real do Admin
const rateLimit = require('express-rate-limit'); // Contra ataques de Spam/DDoS

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
// ==========================================
// 1. TRAVA DE SEGURANÇA: CORS RESTRITO
// ==========================================
// URL principal do Front-end (usada para os redirecionamentos de QR Code/NFC)
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://nfc-avaliation.github.io';

// Lista branca (Whitelist) de domínios permitidos a aceder à sua API
const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'https://nfc-avaliation.github.io',
    FRONTEND_URL
];

const corsOptions = {
    origin: function (origin, callback) {
        // Se a origem estiver na lista ou não houver origem (ex: Postman/Navegador direto), permite.
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Acesso bloqueado pelo CORS'));
        }
    },
    credentials: true // Permite o envio de cabeçalhos de autorização
};

app.use(cors(corsOptions));
app.use(express.json());

// ==========================================
// 2. TRAVA DE SEGURANÇA: RATE LIMITING (Anti-DDoS)
// ==========================================
// Limita cada IP a 100 requisições por minuto. Impede que robôs derrubem a API.
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 100,
    message: { error: 'Muitas requisições originadas deste IP. Aguarde um minuto.' }
});
app.use('/api/', apiLimiter);

// Configuração do Socket.io com CORS explícito e protegido
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true
    }
});

// Configurações do Sistema de Banco de Dados
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:JTSZTBKgDTGCZ5LF@db.jfyjrtllkqmvixosrtof.supabase.co:5432/postgres',
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
    console.error('Erro inesperado no banco de dados:', err);
});

// Credenciais de Admin Seguras
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'chave_super_secreta_restaurante_2026';

// ==========================================
// 3. TRAVA DE SEGURANÇA: MIDDLEWARE DE AUTENTICAÇÃO (JWT)
// ==========================================
function verifyAdminToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN_AQUI"

    if (!token) return res.status(401).json({ error: 'Acesso negado. Token ausente.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido ou expirado. Faça login novamente.' });
        req.user = user;
        next(); // Token válido, pode prosseguir para a rota
    });
}

io.on('connection', (socket) => {
    console.log(`Cliente conectado: ${socket.id}`);
    socket.on('disconnect', () => console.log(`Cliente desconectado: ${socket.id}`));
});

function atualizarPainel() {
    io.emit('atualizacao_dados');
}

// ==========================================
// ROTA DE LOGIN DO PAINEL (Gera o JWT)
// ==========================================
app.post('/api/admin/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        // Gera um token válido por 12 horas
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
        return res.json({ success: true, token });
    }
    res.status(401).json({ error: 'Utilizador ou senha incorretos!' });
});

// ==========================================
// ROTAS PÚBLICAS (CLIENTES NA MESA) - Não precisam de JWT, usam a Sessão NFC
// ==========================================

app.get('/api/mesa/acessar', async (req, res) => {
    const { mesa } = req.query;
    if (!mesa) return res.status(400).send('Número da mesa não especificado.');

    let client;
    try {
        client = await pool.connect();
        const mesaRes = await client.query('SELECT id, status, token_sessao FROM mesas WHERE numero::text = $1', [mesa]);
        
        if (mesaRes.rows.length === 0) return res.status(404).send('Mesa não encontrada no sistema.');

        let mesaObj = mesaRes.rows[0];
        let token = mesaObj.token_sessao;

        if (!token || mesaObj.status === 'livre') {
            token = 'tok_' + crypto.randomBytes(16).toString('hex');
            await client.query('UPDATE mesas SET token_sessao = $1 WHERE id = $2', [token, mesaObj.id]);
        }

        // Usa a variável FRONTEND_URL definida no topo
        res.redirect(`${FRONTEND_URL}/index.html?mesa=${mesa}&token=${token}`);
    } catch (error) {
        res.status(500).send('Erro interno ao acessar a mesa.');
    } finally {
        if (client) client.release();
    }
});

app.post('/api/mesa/sessao', async (req, res) => {
    const { mesa_numero } = req.body;
    let client;
    try {
        client = await pool.connect();
        const mesaRes = await client.query('SELECT id, status, token_sessao FROM mesas WHERE numero::text = $1', [mesa_numero]);
        if (mesaRes.rows.length === 0) return res.status(404).json({ error: 'Mesa não encontrada' });

        let mesa = mesaRes.rows[0];
        let token = mesa.token_sessao;

        if (!token || mesa.status === 'livre') {
            token = 'tok_' + crypto.randomBytes(16).toString('hex');
            await client.query('UPDATE mesas SET token_sessao = $1 WHERE id = $2', [token, mesa.id]);
        }
        res.json({ success: true, token_sessao: token });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao iniciar sessão' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/pedidos', async (req, res) => {
    const { mesa_numero, cart, token_sessao } = req.body;
    if (!cart || !Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Carrinho vazio' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        
        const mesaRes = await client.query('SELECT id, token_sessao, status FROM mesas WHERE numero::text = $1 FOR UPDATE', [mesa_numero]);
        if (mesaRes.rows.length === 0) throw new Error('MESA_NOT_FOUND');
        const mesa = mesaRes.rows[0];

        if (!mesa.token_sessao || mesa.token_sessao !== token_sessao) throw new Error('INVALID_SESSION');

        let comandaRes = await client.query('SELECT id FROM comandas WHERE mesa_id = $1 AND (LOWER(status) = \'aberta\' OR status IS NULL)', [mesa.id]);
        let comanda_id;

        if (comandaRes.rows.length === 0) {
            const codigo = `#${Math.floor(100 + Math.random() * 900)}`;
            const novaComanda = await client.query('INSERT INTO comandas (codigo, mesa_id, status) VALUES ($1, $2, $3) RETURNING id', [codigo, mesa.id, 'aberta']);
            comanda_id = novaComanda.rows[0].id;
            await client.query('UPDATE mesas SET status = $1 WHERE id = $2', ['ocupada', mesa.id]);
        } else {
            comanda_id = comandaRes.rows[0].id;
        }

        for (const item of cart) {
            await client.query(
                `INSERT INTO comanda_itens (comanda_id, nome_item, quantidade, preco_unitario, observacoes) VALUES ($1, $2, $3, $4, $5)`,
                [comanda_id, item.name, item.quantity, item.unitPrice, item.notes || '']
            );
        }

        await client.query('COMMIT');
        atualizarPainel();
        io.emit('notificacao_painel', { titulo: 'Novo Pedido', msg: `Mesa ${mesa_numero} enviou um pedido.`, tipo: 'success' });
        res.json({ success: true, message: 'Pedido enviado!' });

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        if (error.message === 'MESA_NOT_FOUND') return res.status(404).json({ error: 'Mesa não encontrada' });
        if (error.message === 'INVALID_SESSION') return res.status(403).json({ error: 'Sessão inválida' });
        res.status(500).json({ error: 'Erro ao processar pedido' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/garcom', async (req, res) => {
    const { mesa_numero, token_sessao } = req.body;
    let client;
    try {
        client = await pool.connect();
        const mesaRes = await client.query('SELECT id, token_sessao FROM mesas WHERE numero::text = $1', [mesa_numero]);
        if (mesaRes.rows.length > 0) {
            if (!mesaRes.rows[0].token_sessao || mesaRes.rows[0].token_sessao !== token_sessao) {
                return res.status(403).json({ error: 'Sessão inválida.' });
            }
            await client.query('UPDATE mesas SET chamando_garcom = TRUE WHERE id = $1', [mesaRes.rows[0].id]);
            atualizarPainel();
            io.emit('chamada_garcom', { mesa: mesa_numero });
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Mesa não encontrada' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Erro ao chamar garçom' });
    } finally {
        if (client) client.release();
    }
});

// ==========================================
// ROTAS ADMINISTRATIVAS - BLINDADAS COM `verifyAdminToken`
// ==========================================

app.post('/api/garcom/atender', verifyAdminToken, async (req, res) => {
    try {
        await pool.query('UPDATE mesas SET chamando_garcom = FALSE WHERE id = $1', [req.body.mesa_id]);
        atualizarPainel();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atender garçom' });
    }
});

app.get('/api/mesas', verifyAdminToken, async (req, res) => {
    try {
        const query = `
            SELECT m.id as mesa_id, m.numero, m.status, m.chamando_garcom, c.id as comanda_id, c.codigo as comanda_codigo, c.data_abertura,
                COALESCE((SELECT json_agg(json_build_object('id', ci.id, 'nome_item', ci.nome_item, 'preco_unitario', ci.preco_unitario, 'quantidade', ci.quantidade, 'observacoes', ci.observacoes)) FROM comanda_itens ci WHERE ci.comanda_id = c.id), '[]'::json) as items
            FROM mesas m LEFT JOIN comandas c ON m.id = c.mesa_id AND (LOWER(c.status) = 'aberta' OR c.status IS NULL)
            ORDER BY m.numero ASC;
        `;
        const mesasRes = await pool.query(query);
        res.json(mesasRes.rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar mesas' });
    }
});

app.post('/api/checkout', verifyAdminToken, async (req, res) => {
    let { comanda_id, mesa_id, forma_pagamento, subtotal, taxa, desconto, final } = req.body;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        
        let comandaTargetId = comanda_id;
        if (mesa_id && !comanda_id) {
            const comandasAbertas = await client.query('SELECT id FROM comandas WHERE mesa_id = $1 AND (LOWER(status) = \'aberta\' OR status IS NULL)', [mesa_id]);
            if (comandasAbertas.rows.length > 0) comandaTargetId = comandasAbertas.rows[0].id;
        }

        if (comandaTargetId) {
            const itensSum = await client.query('SELECT SUM(quantidade * preco_unitario) as soma FROM comanda_itens WHERE comanda_id = $1', [comandaTargetId]);
            let comSubtotal = itensSum.rows[0]?.soma || subtotal || 0;
            let comFinal = comSubtotal - (desconto || 0) + (taxa || 0);

            await client.query(`UPDATE comandas SET status = 'fechada', data_fechamento = NOW(), forma_pagamento = $1, subtotal = $2, taxa_servico = $3, desconto = $4, valor_total_final = $5 WHERE id = $6`,
                [forma_pagamento || 'CARTAO', comSubtotal, taxa || 0, desconto || 0, comFinal, comandaTargetId]);
        }

        if (mesa_id) await client.query('UPDATE mesas SET status = $1, chamando_garcom = FALSE, token_sessao = NULL WHERE id = $2', ['livre', mesa_id]);
        
        await client.query('COMMIT');
        atualizarPainel();
        res.json({ success: true });
    } catch (error) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Erro ao fechar comanda' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/admin/mesa/cancelar', verifyAdminToken, async (req, res) => {
    let { mesa_id, comanda_id } = req.body;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        
        if (!comanda_id && mesa_id) {
            const comRes = await client.query('SELECT id FROM comandas WHERE mesa_id = $1 AND LOWER(status) = \'aberta\'', [mesa_id]);
            if (comRes.rows.length > 0) comanda_id = comRes.rows[0].id;
        }

        if (comanda_id) {
            await client.query('DELETE FROM comanda_itens WHERE comanda_id = $1', [comanda_id]);
            await client.query('DELETE FROM comandas WHERE id = $1', [comanda_id]);
        }
        if (mesa_id) await client.query('UPDATE mesas SET status = $1, chamando_garcom = FALSE, token_sessao = NULL WHERE id = $2', ['livre', mesa_id]);

        await client.query('COMMIT');
        atualizarPainel();
        res.json({ success: true, message: 'Mesa cancelada.' });
    } catch (error) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Erro ao cancelar' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/admin/mesa/adicionar-itens', verifyAdminToken, async (req, res) => {
    let { mesa_id, cart } = req.body;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        let comandaRes = await client.query('SELECT id FROM comandas WHERE mesa_id = $1 AND LOWER(status) = \'aberta\'', [mesa_id]);
        let comanda_id;

        if (comandaRes.rows.length === 0) {
            const codigo = `#${Math.floor(100 + Math.random() * 900)}`;
            const novaComanda = await client.query('INSERT INTO comandas (codigo, mesa_id, status) VALUES ($1, $2, $3) RETURNING id', [codigo, mesa_id, 'aberta']);
            comanda_id = novaComanda.rows[0].id;
            await client.query('UPDATE mesas SET status = $1 WHERE id = $2', ['ocupada', mesa_id]);
        } else {
            comanda_id = comandaRes.rows[0].id;
        }

        for (const item of cart) {
            await client.query(`INSERT INTO comanda_itens (comanda_id, nome_item, quantidade, preco_unitario, observacoes) VALUES ($1, $2, $3, $4, $5)`,
                [comanda_id, item.name, item.quantity, item.unitPrice, item.notes || '']);
        }

        await client.query('COMMIT');
        atualizarPainel();
        res.json({ success: true });
    } catch (error) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'Erro ao adicionar' });
    } finally {
        if (client) client.release();
    }
});

app.delete('/api/admin/comanda-item/:id', verifyAdminToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM comanda_itens WHERE id = $1', [req.params.id]);
        atualizarPainel();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao apagar' });
    }
});

app.get('/api/historico', verifyAdminToken, async (req, res) => {
    const { filtro } = req.query;
    try {
        let query = `
            SELECT c.id, c.codigo, c.status, c.data_abertura, c.data_fechamento, c.forma_pagamento, c.valor_total_final, COALESCE(m.numero, '0') as mesa_numero,
                   COALESCE((SELECT json_agg(json_build_object('nome_item', ci.nome_item, 'quantidade', ci.quantidade, 'preco_unitario', ci.preco_unitario, 'observacoes', ci.observacoes)) FROM comanda_itens ci WHERE ci.comanda_id = c.id), '[]'::json) as items
            FROM comandas c LEFT JOIN mesas m ON c.mesa_id = m.id WHERE (LOWER(c.status) = 'fechada' OR c.data_fechamento IS NOT NULL)
        `;
        if (filtro === 'dia') query += ` AND c.data_fechamento >= NOW() - INTERVAL '1 day'`;
        else if (filtro === 'semana') query += ` AND c.data_fechamento >= NOW() - INTERVAL '7 days'`;
        else if (filtro === 'mes') query += ` AND c.data_fechamento >= NOW() - INTERVAL '30 days'`;
        query += ` ORDER BY c.data_fechamento DESC LIMIT 150`;

        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro no histórico' });
    }
});

app.get('/api/estatisticas', verifyAdminToken, async (req, res) => {
    try {
        const fatDia = pool.query(`SELECT SUM(valor_total_final) as total FROM comandas WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL) AND data_fechamento >= NOW() - INTERVAL '1 day'`);
        const fatSemana = pool.query(`SELECT SUM(valor_total_final) as total FROM comandas WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL) AND data_fechamento >= NOW() - INTERVAL '7 days'`);
        const fatMes = pool.query(`SELECT SUM(valor_total_final) as total FROM comandas WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL) AND data_fechamento >= NOW() - INTERVAL '30 days'`);
        const itensVendidos = pool.query(`SELECT ci.nome_item, SUM(ci.quantidade) as total_qtd FROM comanda_itens ci JOIN comandas c ON ci.comanda_id = c.id WHERE (LOWER(c.status) = 'fechada' OR c.data_fechamento IS NOT NULL) GROUP BY ci.nome_item ORDER BY total_qtd DESC`);
        const horaPico = pool.query(`SELECT EXTRACT(HOUR FROM data_abertura) as hora, COUNT(*) as qtd FROM comandas WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL) AND data_abertura IS NOT NULL GROUP BY hora ORDER BY qtd DESC LIMIT 1`);
        const diaPico = pool.query(`SELECT TO_CHAR(data_abertura, 'Day') as dia, COUNT(*) as qtd FROM comandas WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL) AND data_abertura IS NOT NULL GROUP BY dia ORDER BY qtd DESC LIMIT 1`);

        const [rFatDia, rFatSemana, rFatMes, rItens, rHora, rDia] = await Promise.all([fatDia, fatSemana, fatMes, itensVendidos, horaPico, diaPico]);

        res.json({
            faturamento: { dia: rFatDia.rows[0]?.total || 0, semana: rFatSemana.rows[0]?.total || 0, mes: rFatMes.rows[0]?.total || 0 },
            itens: rItens.rows || [],
            horaPico: rHora.rows.length > 0 ? `${Math.floor(rHora.rows[0].hora)}:00` : 'N/A',
            diaPico: rDia.rows.length > 0 ? rDia.rows[0].dia.trim() : 'N/A'
        });
    } catch (error) {
        res.status(500).json({ error: 'Erro nas estatísticas' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando protegido na porta ${PORT}`);
});
