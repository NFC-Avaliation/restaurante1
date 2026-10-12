const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
    cors: { origin: "*" }
});

// Configuração da ligação ao Supabase (PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:JTSZTBKgDTGCZ5LF@db.jfyjrtllkqmvixosrtof.supabase.co:5432/postgres',
    ssl: { rejectUnauthorized: false }
});

// WebSockets em tempo real
io.on('connection', (socket) => {
    console.log(`Novo cliente ligado: ${socket.id}`);
    
    socket.on('disconnect', () => {
        console.log(`Cliente desligado: ${socket.id}`);
    });
});

function atualizarPainel() {
    io.emit('atualizacao_dados');
}

// 0. Gerar ou recuperar Sessão Segura da Mesa (NFC)
app.post('/api/mesa/sessao', async (req, res) => {
    const { mesa_numero } = req.body;
    try {
        const client = await pool.connect();
        const mesaRes = await client.query('SELECT id, status, token_sessao FROM mesas WHERE TRIM(numero) = TRIM($1)', [mesa_numero]);
        
        if (mesaRes.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'Mesa não encontrada' });
        }

        let mesa = mesaRes.rows[0];
        let token = mesa.token_sessao;

        if (!token || mesa.status === 'livre') {
            token = 'tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
            await client.query('UPDATE mesas SET token_sessao = $1 WHERE id = $2', [token, mesa.id]);
        }

        client.release();
        res.json({ success: true, token_sessao: token });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao iniciar sessão da mesa' });
    }
});

// 1. Cliente faz um Novo Pedido (com validação de token)
app.post('/api/pedidos', async (req, res) => {
    const { mesa_numero, cart, token_sessao } = req.body;
    
    try {
        const client = await pool.connect();
        
        const mesaRes = await client.query('SELECT id, token_sessao, status FROM mesas WHERE TRIM(numero) = TRIM($1)', [mesa_numero]);
        if (mesaRes.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'Mesa não encontrada' });
        }
        
        const mesa = mesaRes.rows[0];

        if (!mesa.token_sessao || mesa.token_sessao !== token_sessao) {
            client.release();
            return res.status(403).json({ error: 'Sessão inválida ou expirada para esta mesa.' });
        }

        const mesa_id = mesa.id;

        let comandaRes = await client.query('SELECT id FROM comandas WHERE mesa_id = $1 AND (LOWER(status) = \'aberta\' OR status IS NULL)', [mesa_id]);
        let comanda_id;

        if (comandaRes.rows.length === 0) {
            const codigo = `#${Math.floor(100 + Math.random() * 900)}`;
            const novaComanda = await client.query(
                'INSERT INTO comandas (codigo, mesa_id, status) VALUES ($1, $2, $3) RETURNING id', [codigo, mesa_id, 'aberta']
            );
            comanda_id = novaComanda.rows[0].id;
            
            await client.query('UPDATE mesas SET status = $1 WHERE id = $2', ['ocupada', mesa_id]);
        } else {
            comanda_id = comandaRes.rows[0].id;
        }

        for (const item of cart) {
            await client.query(
                `INSERT INTO comanda_itens (comanda_id, item_id_cache, nome_item, quantidade, preco_unitario, observacoes) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [comanda_id, item.dishId, item.name, item.quantity, item.unitPrice, item.notes || '']
            );
        }

        client.release();
        
        atualizarPainel();
        io.emit('notificacao_painel', { titulo: 'Novo Pedido', msg: `Mesa ${mesa_numero} enviou um pedido.`, tipo: 'success' });

        res.json({ success: true, message: 'Pedido enviado para a cozinha!' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao processar pedido' });
    }
});

// 2. Cliente Chama o Garçom (com validação de token)
app.post('/api/garcom', async (req, res) => {
    const { mesa_numero, token_sessao } = req.body;

    try {
        const client = await pool.connect();
        const mesaRes = await client.query('SELECT id, token_sessao FROM mesas WHERE TRIM(numero) = TRIM($1)', [mesa_numero]);
        
        if (mesaRes.rows.length > 0) {
            const mesa = mesaRes.rows[0];
            
            if (!mesa.token_sessao || mesa.token_sessao !== token_sessao) {
                client.release();
                return res.status(403).json({ error: 'Sessão inválida.' });
            }

            const mesa_id = mesa.id;
            await client.query(
                'UPDATE mesas SET chamando_garcom = TRUE, hora_ultimo_chamado = NOW() WHERE id = $1', 
                [mesa_id]
            );
            await client.query(
                'INSERT INTO chamadas_garcom (mesa_id) VALUES ($1)', [mesa_id]
            );
        }
        client.release();

        atualizarPainel();
        io.emit('chamada_garcom', { mesa: mesa_numero });

        res.json({ success: true, message: 'Garçom chamado com sucesso' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao chamar garçom' });
    }
});

// 3. Painel busca o status de todas as mesas
app.get('/api/mesas', async (req, res) => {
    try {
        const client = await pool.connect();
        
        const mesasRes = await client.query(`
            SELECT 
                m.id as mesa_id, m.numero, m.status, m.chamando_garcom, m.hora_ultimo_chamado,
                c.id as comanda_id, c.codigo as comanda_codigo, c.data_abertura
            FROM mesas m
            LEFT JOIN comandas c ON m.id = c.mesa_id AND (LOWER(c.status) = 'aberta' OR c.status IS NULL)
        `);

        let mesas = mesasRes.rows;

        for (let mesa of mesas) {
            mesa.items = [];
            if (mesa.comanda_id) {
                const itensRes = await client.query(
                    'SELECT * FROM comanda_itens WHERE comanda_id = $1', [mesa.comanda_id]
                );
                mesa.items = itensRes.rows;
            }
        }

        client.release();
        res.json(mesas);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao buscar mesas' });
    }
});

// 4. Painel atende o Garçom
app.post('/api/garcom/atender', async (req, res) => {
    const { mesa_id } = req.body;
    try {
        const client = await pool.connect();
        await client.query('UPDATE mesas SET chamando_garcom = FALSE WHERE id = $1', [mesa_id]);
        await client.query('UPDATE chamadas_garcom SET status = $1, data_atendimento = NOW() WHERE mesa_id = $2 AND status = $3', ['atendida', mesa_id, 'pendente']);
        client.release();
        
        atualizarPainel();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro' });
    }
});

// 5. Painel fecha a Comanda (Checkout) robusto e automático
app.post('/api/checkout', async (req, res) => {
    let { comanda_id, mesa_id, forma_pagamento, subtotal, taxa, desconto, final } = req.body;
    let client;
    try {
        client = await pool.connect();
        
        // Fecha todas as comandas abertas desta mesa para garantir consistência
        if (mesa_id) {
            const comandasAbertas = await client.query('SELECT id FROM comandas WHERE mesa_id = $1 AND (LOWER(status) = \'aberta\' OR status IS NULL)', [mesa_id]);
            
            for (let com of comandasAbertas.rows) {
                let currentComandaId = com.id;
                
                const itensSum = await client.query('SELECT SUM(quantidade * preco_unitario) as soma FROM comanda_itens WHERE comanda_id = $1', [currentComandaId]);
                let comSubtotal = itensSum.rows[0]?.soma || subtotal || 0;
                let comFinal = comSubtotal - (desconto || 0) + (taxa || 0);

                await client.query(`
                    UPDATE comandas SET 
                    status = 'fechada', data_fechamento = NOW(), 
                    forma_pagamento = $1, subtotal = $2, taxa_servico = $3, desconto = $4, valor_total_final = $5
                    WHERE id = $6`,
                    [forma_pagamento || 'CARTAO', comSubtotal, taxa || 0, desconto || 0, comFinal, currentComandaId]
                );
            }
        } else if (comanda_id) {
            const itensSum = await client.query('SELECT SUM(quantidade * preco_unitario) as soma FROM comanda_itens WHERE comanda_id = $1', [comanda_id]);
            let comSubtotal = itensSum.rows[0]?.soma || subtotal || 0;
            let comFinal = comSubtotal - (desconto || 0) + (taxa || 0);

            await client.query(`
                UPDATE comandas SET 
                status = 'fechada', data_fechamento = NOW(), 
                forma_pagamento = $1, subtotal = $2, taxa_servico = $3, desconto = $4, valor_total_final = $5
                WHERE id = $6`,
                [forma_pagamento || 'CARTAO', comSubtotal, taxa || 0, desconto || 0, comFinal, comanda_id]
            );
        }

        // Liberta a mesa, limpa chamadas e apaga o token de sessão
        await client.query('UPDATE mesas SET status = $1, chamando_garcom = FALSE, token_sessao = NULL WHERE id = $2', ['livre', mesa_id]);
        
        client.release();
        atualizarPainel();
        res.json({ success: true });
    } catch (error) {
        if (client) client.release();
        console.error("Erro ao fechar comanda:", error);
        res.status(500).json({ error: 'Erro ao fechar comanda' });
    }
});

// 6. Histórico de Pedidos / Comandas Fechadas (Blindado)
app.get('/api/historico', async (req, res) => {
    const { filtro } = req.query; // 'dia', 'semana', 'mes', 'todos'
    let client;
    try {
        client = await pool.connect();
        let query = `
            SELECT c.id, c.codigo, c.status, c.data_abertura, c.data_fechamento, 
                   c.forma_pagamento, c.valor_total_final, m.numero as mesa_numero
            FROM comandas c 
            JOIN mesas m ON c.mesa_id = m.id 
            WHERE (LOWER(c.status) = 'fechada' OR c.data_fechamento IS NOT NULL)
        `;
        
        if (filtro === 'dia') {
            query += ` AND c.data_fechamento >= CURRENT_DATE`;
        } else if (filtro === 'semana') {
            query += ` AND c.data_fechamento >= NOW() - INTERVAL '7 days'`;
        } else if (filtro === 'mes') {
            query += ` AND c.data_fechamento >= NOW() - INTERVAL '30 days'`;
        }
        
        query += ` ORDER BY c.data_fechamento DESC LIMIT 150`;

        const result = await client.query(query);
        let comandas = result.rows;

        for (let comanda of comandas) {
            const itensRes = await client.query(
                'SELECT nome_item, quantidade, preco_unitario, observacoes FROM comanda_itens WHERE comanda_id = $1',
                [comanda.id]
            );
            comanda.items = itensRes.rows;
        }

        client.release();
        res.json(comandas);
    } catch (error) {
        if (client) client.release();
        console.error("Erro ao buscar histórico:", error);
        res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
});

// 7. Estatísticas e Métricas (Blindado)
app.get('/api/estatisticas', async (req, res) => {
    let client;
    try {
        client = await pool.connect();

        const fatDia = await client.query(`SELECT SUM(valor_total_final) as total FROM comandas WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL) AND data_fechamento >= CURRENT_DATE`);
        const fatSemana = await client.query(`SELECT SUM(valor_total_final) as total FROM comandas WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL) AND data_fechamento >= NOW() - INTERVAL '7 days'`);
        const fatMes = await client.query(`SELECT SUM(valor_total_final) as total FROM comandas WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL) AND data_fechamento >= NOW() - INTERVAL '30 days'`);

        const itensVendidos = await client.query(`
            SELECT nome_item, SUM(quantidade) as total_qtd 
            FROM comanda_itens ci
            JOIN comandas c ON ci.comanda_id = c.id
            WHERE (LOWER(c.status) = 'fechada' OR c.data_fechamento IS NOT NULL)
            GROUP BY nome_item 
            ORDER BY total_qtd DESC
        `);

        const horaPico = await client.query(`
            SELECT EXTRACT(HOUR FROM data_abertura) as hora, COUNT(*) as qtd
            FROM comandas
            WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL)
            GROUP BY hora
            ORDER BY qtd DESC
            LIMIT 1
        `);

        const diaPico = await client.query(`
            SELECT TO_CHAR(data_abertura, 'Day') as dia, COUNT(*) as qtd
            FROM comandas
            WHERE (LOWER(status) = 'fechada' OR data_fechamento IS NOT NULL)
            GROUP BY dia
            ORDER BY qtd DESC
            LIMIT 1
        `);

        client.release();

        res.json({
            faturamento: {
                dia: fatDia.rows[0]?.total || 0,
                semana: fatSemana.rows[0]?.total || 0,
                mes: fatMes.rows[0]?.total || 0
            },
            itens: itensVendidos.rows,
            horaPico: horaPico.rows.length > 0 ? `${Math.floor(horaPico.rows[0].hora)}:00` : 'N/A',
            diaPico: diaPico.rows.length > 0 ? diaPico.rows[0].dia.trim() : 'N/A'
        });
    } catch (error) {
        if (client) client.release();
        console.error("Erro ao calcular estatísticas:", error);
        res.status(500).json({ error: 'Erro ao calcular estatísticas' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});
