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

// 1. Cliente faz um Novo Pedido
app.post('/api/pedidos', async (req, res) => {
    const { mesa_numero, cart } = req.body;
    
    try {
        const client = await pool.connect();
        
        // Acha a mesa
        const mesaRes = await client.query('SELECT id FROM mesas WHERE numero = $1', [mesa_numero]);
        if (mesaRes.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'Mesa não encontrada' });
        }
        const mesa_id = mesaRes.rows[0].id;

        // Verifica se já tem comanda aberta, caso contrário cria uma
        let comandaRes = await client.query('SELECT id FROM comandas WHERE mesa_id = $1 AND status = $2', [mesa_id, 'aberta']);
        let comanda_id;

        if (comandaRes.rows.length === 0) {
            const codigo = `#${Math.floor(100 + Math.random() * 900)}`;
            const novaComanda = await client.query(
                'INSERT INTO comandas (codigo, mesa_id) VALUES ($1, $2) RETURNING id', [codigo, mesa_id]
            );
            comanda_id = novaComanda.rows[0].id;
            
            await client.query('UPDATE mesas SET status = $1 WHERE id = $2', ['ocupada', mesa_id]);
        } else {
            comanda_id = comandaRes.rows[0].id;
        }

        // Insere os itens do carrinho
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

// 2. Cliente Chama o Garçom
app.post('/api/garcom', async (req, res) => {
    const { mesa_numero } = req.body;

    try {
        const client = await pool.connect();
        const mesaRes = await client.query('SELECT id FROM mesas WHERE numero = $1', [mesa_numero]);
        if (mesaRes.rows.length > 0) {
            const mesa_id = mesaRes.rows[0].id;
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
            LEFT JOIN comandas c ON m.id = c.mesa_id AND c.status = 'aberta'
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

// 5. Painel fecha a Comanda (Checkout)
app.post('/api/checkout', async (req, res) => {
    const { comanda_id, mesa_id, forma_pagamento, subtotal, taxa, desconto, final } = req.body;
    try {
        const client = await pool.connect();
        
        await client.query(`
            UPDATE comandas SET 
            status = 'fechada', data_fechamento = NOW(), 
            forma_pagamento = $1, subtotal = $2, taxa_servico = $3, desconto = $4, valor_total_final = $5
            WHERE id = $6`,
            [forma_pagamento, subtotal, taxa, desconto, final, comanda_id]
        );

        await client.query('UPDATE mesas SET status = $1, chamando_garcom = FALSE WHERE id = $2', ['livre', mesa_id]);
        
        client.release();
        atualizarPainel();
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao fechar comanda' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});