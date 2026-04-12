const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// ── RS-232 Scale Integration ──
let mainWindow = null;

const dbPath = path.join(app.getPath('userData'), 'scrapyard.db');
const db = new sqlite3.Database(dbPath);

// Secure folder for Driver's License images and location images
const imagesPath = path.join(app.getPath('userData'), 'dl_images');
const locationImagesPath = path.join(app.getPath('userData'), 'location_images');
const vinImagesPath = path.join(app.getPath('userData'), 'vin_images');
if (!fs.existsSync(imagesPath)) { 
    fs.mkdirSync(imagesPath, { recursive: true }); 
}
if (!fs.existsSync(locationImagesPath)) { 
    fs.mkdirSync(locationImagesPath, { recursive: true }); 
}
if (!fs.existsSync(vinImagesPath)) { 
    fs.mkdirSync(vinImagesPath, { recursive: true }); 
}

function initializeDatabase() {
    db.serialize(() => {
        // 1. Core Tables
        db.run(`CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, id_number TEXT, vehicle_plate TEXT, created_at TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, date TEXT, total_amount REAL, base_total REAL, is_overridden INTEGER DEFAULT 0, transaction_type TEXT DEFAULT 'sale', FOREIGN KEY(customer_id) REFERENCES customers(id))`);
        db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, material_name TEXT, price_per_lb REAL)`);
        db.run(`CREATE TABLE IF NOT EXISTS ticket_items (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, material_name TEXT, net_weight REAL, total_price REAL, base_price REAL, is_price_overridden INTEGER DEFAULT 0, scale_reading REAL, FOREIGN KEY(ticket_id) REFERENCES transactions(id))`);
        
        // 2. Voucher System
        db.run(`CREATE TABLE IF NOT EXISTS vouchers (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, voucher_code TEXT UNIQUE, customer_id INTEGER, amount REAL, created_at TEXT, expires_at TEXT, redeemed_at TEXT, is_redeemed INTEGER DEFAULT 0, FOREIGN KEY(ticket_id) REFERENCES transactions(id), FOREIGN KEY(customer_id) REFERENCES customers(id))`);
        
        // 3. Copper Hold Tracking
        db.run(`CREATE TABLE IF NOT EXISTS copper_holds (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, hold_start TEXT, hold_expiry TEXT, is_released INTEGER DEFAULT 0, release_date TEXT, FOREIGN KEY(ticket_id) REFERENCES transactions(id))`);
        
        // 4. Inventory Management
        db.run(`CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, material_id INTEGER, quantity_lbs REAL, location TEXT, date_added TEXT, expiry_date TEXT, FOREIGN KEY(material_id) REFERENCES products(id))`);
        
        // 5. Price History Tracking
        db.run(`CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, material_id INTEGER, old_price REAL, new_price REAL, changed_at TEXT, changed_by TEXT, FOREIGN KEY(material_id) REFERENCES products(id))`);
        
        // 6. Customer Account Balances
        db.run(`CREATE TABLE IF NOT EXISTS customer_balances (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER UNIQUE, balance REAL DEFAULT 0, last_updated TEXT, FOREIGN KEY(customer_id) REFERENCES customers(id))`);

        // 7. Vehicle Purchases (cars, trucks bought for scrap)
        db.run(`CREATE TABLE IF NOT EXISTS vehicle_purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER,
            vin TEXT,
            make TEXT,
            model TEXT,
            year TEXT,
            color TEXT,
            description TEXT,
            condition_notes TEXT,
            has_title INTEGER DEFAULT 0,
            has_registration INTEGER DEFAULT 0,
            title_number TEXT,
            created_at TEXT,
            FOREIGN KEY(ticket_id) REFERENCES transactions(id)
        )`);
        
        // Performance indexes
        db.run(`CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_ticket_items_ticket ON ticket_items(ticket_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_vouchers_ticket ON vouchers(ticket_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_vouchers_customer ON vouchers(customer_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_copper_holds_ticket ON copper_holds(ticket_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_copper_holds_expiry ON copper_holds(hold_expiry)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_inventory_material ON inventory(material_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_price_history_material ON price_history(material_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_customer_balances ON customer_balances(customer_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_vehicle_purchases_ticket ON vehicle_purchases(ticket_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_vehicle_purchases_vin ON vehicle_purchases(vin)`);

        // Add vin_image column to vehicle_purchases (safe to re-run)
        db.run(`ALTER TABLE vehicle_purchases ADD COLUMN vin_image TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Migration error adding vin_image:', err.message);
            }
        });

        // Ensure vehicle material exists on every DB (safe to re-run)
        db.get(`SELECT id FROM products WHERE material_name = 'Whole Vehicle'`, (err, row) => {
            if (!err && !row) {
                db.run(`INSERT INTO products (material_name, price_per_lb) VALUES ('Whole Vehicle', 0.00)`);
            }
        });
        
        // 2. Auto-Upgrade Existing Database for CRM Features
        const newColumns = [
            "dl_expiration TEXT", "dl_picture TEXT", "location_image TEXT", 
            "truck_description TEXT", "phone TEXT", "address TEXT", "email TEXT",
            "is_vendor INTEGER DEFAULT 0",
            "dealer_exemption INTEGER DEFAULT 0",
            "dealer_number TEXT"
        ];
        newColumns.forEach(col => { 
            db.run(`ALTER TABLE customers ADD COLUMN ${col}`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error(`Migration error adding column ${col}:`, err.message);
                }
            }); 
        });
        
        // Add missing transaction columns
        const txnColumns = [
            "is_customer INTEGER DEFAULT 1",
            "transaction_type TEXT DEFAULT 'sale'",
            "base_total REAL",
            "is_overridden INTEGER DEFAULT 0"
        ];
        txnColumns.forEach(col => {
            db.run(`ALTER TABLE transactions ADD COLUMN ${col}`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error(`Migration error adding txn column:`, err.message);
                }
            });
        });

        // Add missing ticket_items columns
        const itemColumns = [
            "base_price REAL",
            "is_price_overridden INTEGER DEFAULT 0",
            "scale_reading REAL"
        ];
        itemColumns.forEach(col => {
            db.run(`ALTER TABLE ticket_items ADD COLUMN ${col}`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error(`Migration error adding item column:`, err.message);
                }
            });
        });
        
        // Insert default materials if none exist
        db.get(`SELECT COUNT(*) as count FROM products`, (err, row) => {
            if (err) { console.error('Error checking products count:', err.message); return; }
            if (row.count === 0) {
                const defaultProducts = [
                    { name: 'Copper #1', price: 3.85 },
                    { name: 'Copper #2', price: 3.45 },
                    { name: 'Aluminum', price: 0.65 },
                    { name: 'Steel', price: 0.12 },
                    { name: 'Stainless Steel', price: 0.45 },
                    { name: 'Brass', price: 2.15 },
                    { name: 'Lead', price: 0.85 },
                    { name: 'Zinc', price: 0.55 }
                ];
                
                const stmt = db.prepare(`INSERT INTO products (material_name, price_per_lb) VALUES (?, ?)`);
                defaultProducts.forEach(product => {
                    stmt.run(product.name, product.price);
                });
                stmt.finalize();
            }
        });
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: { 
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false, 
            contextIsolation: true,
            webSecurity: false // Allows loading local ID images
        }
    });
    mainWindow.loadFile('index.html');
    return mainWindow;
}

app.whenReady().then(() => { 
    initializeDatabase();
    const win = createWindow();
    
    // ── Initialize RS-232 Scale ──
    win.webContents.on('did-finish-load', () => {
        connectScale(win);
    });
});

// --- CORE TRANSACTION HANDLER ---
ipcMain.handle('add-split-ticket', (e, d) => {
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };

        db.serialize(() => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) return settle(reject, err);

                const rollback = (error) => {
                    db.run('ROLLBACK', () => settle(reject, error));
                };

                db.run(`INSERT INTO customers (name, id_number, vehicle_plate, created_at) 
                        VALUES (?, ?, ?, datetime('now')) 
                        ON CONFLICT(name) DO UPDATE SET id_number=excluded.id_number, vehicle_plate=excluded.vehicle_plate`, 
                [d.customer_name, d.id_number, d.vehicle_plate], function(err) {
                    if (err) return rollback(err);
                    
                    db.get(`SELECT id FROM customers WHERE name = ?`, [d.customer_name], (err, cust) => {
                        if (err || !cust) return rollback(err || new Error("Customer lookup failed"));
                        
                        const cId = cust.id;
                        db.run(`INSERT INTO transactions (customer_id, date, total_amount) VALUES (?, datetime('now', 'localtime'), ?)`, 
                        [cId, d.total_amount], function(err) {
                            if (err) return rollback(err);
                            
                            const tId = this.lastID;
                            if (d.materials.length === 0) {
                                return db.run('COMMIT', (err) => {
                                    if (err) return rollback(err);
                                    settle(resolve, { success: true, ticketId: tId });
                                });
                            }

                            const stmt = db.prepare(`INSERT INTO ticket_items (ticket_id, material_name, net_weight, total_price) VALUES (?, ?, ?, ?)`);
                            let completed = 0;
                            let failed = false;
                            
                            d.materials.forEach(m => {
                                stmt.run(tId, m.material, m.net, m.total, (err) => {
                                    if (failed) return;
                                    if (err) {
                                        failed = true;
                                        stmt.finalize((finalizeErr) => {
                                            if (finalizeErr) console.error('Statement finalize error:', finalizeErr.message);
                                            rollback(err);
                                        });
                                        return;
                                    }
                                    completed++;
                                    if (completed === d.materials.length) {
                                        stmt.finalize((err) => {
                                            if (err) return rollback(err);
                                            db.run('COMMIT', (err) => {
                                                if (err) return rollback(err);
                                                settle(resolve, { success: true, ticketId: tId });
                                            });
                                        });
                                    }
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// --- CRM (CUSTOMER DATABASE) HANDLERS ---

ipcMain.handle('get-all-customers', () => {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT c.*, COUNT(t.id) as ticket_count, COALESCE(SUM(t.total_amount), 0) as lifetime_value 
            FROM customers c 
            LEFT JOIN transactions t ON c.id = t.customer_id 
            GROUP BY c.id 
            ORDER BY c.name ASC`;
        db.all(query, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('create-customer-profile', (e, data) => {
    return new Promise((resolve, reject) => {
        const query = `INSERT INTO customers (name, id_number, dl_expiration, vehicle_plate, truck_description, phone, address, email, is_vendor, dealer_exemption, dealer_number, created_at) 
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`;
        db.run(query, [data.name, data.id_number, data.dl_expiration, data.vehicle_plate, data.truck_description, data.phone, data.address, data.email, data.is_vendor || 0, data.dealer_exemption || 0, data.dealer_number || null], function(err) {
            if (err) reject(err);
            else resolve({ success: true, newId: this.lastID });
        });
    });
});

ipcMain.handle('save-customer-profile', (e, data) => {
    return new Promise((resolve, reject) => {
        const query = `UPDATE customers SET name=?, id_number=?, dl_expiration=?, vehicle_plate=?, truck_description=?, phone=?, address=?, email=?, is_vendor=?, dealer_exemption=?, dealer_number=? WHERE id=?`;
        db.run(query, [data.name, data.id_number, data.dl_expiration, data.vehicle_plate, data.truck_description, data.phone, data.address, data.email, data.is_vendor || 0, data.dealer_exemption || 0, data.dealer_number || null, data.id], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
});

ipcMain.handle('save-dl-image', async (e, { customerId, sourcePath }) => {
    const ext = path.extname(sourcePath);
    const fileName = `dl_${customerId}_${Date.now()}${ext}`;
    const destPath = path.join(imagesPath, fileName);
    
    return new Promise((resolve, reject) => {
        fs.copyFile(sourcePath, destPath, (err) => {
            if (err) return reject(err);
            
            db.run(`UPDATE customers SET dl_picture=? WHERE id=?`, [destPath, customerId], (err) => {
                if (err) reject(err);
                else resolve({ path: destPath });
            });
        });
    });
});

ipcMain.handle('save-location-image', async (e, { customerId, sourcePath }) => {
    const ext = path.extname(sourcePath);
    const fileName = `location_${customerId}_${Date.now()}${ext}`;
    const destPath = path.join(locationImagesPath, fileName);
    
    return new Promise((resolve, reject) => {
        fs.copyFile(sourcePath, destPath, (err) => {
            if (err) return reject(err);
            
            db.run(`UPDATE customers SET location_image=? WHERE id=?`, [destPath, customerId], (err) => {
                if (err) reject(err);
                else resolve({ path: destPath });
            });
        });
    });
});

ipcMain.handle('update-ticket-price', (e, { ticketId, newTotal, isOverridden }) => {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE transactions SET total_amount=?, is_overridden=? WHERE id=?`, 
        [newTotal, isOverridden ? 1 : 0, ticketId], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
});

ipcMain.handle('update-ticket-item-price', (e, { itemId, newPrice, isOverridden }) => {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE ticket_items SET total_price=?, is_price_overridden=? WHERE id=?`, 
        [newPrice, isOverridden ? 1 : 0, itemId], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
});

ipcMain.handle('get-ticket-details-with-customer', (e, ticketId) => {
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT t.id, t.date, t.total_amount, t.base_total, t.is_overridden, t.transaction_type,
                   c.id as customer_id, c.name, c.phone, c.address, c.id_number, c.vehicle_plate
            FROM transactions t
            JOIN customers c ON t.customer_id = c.id
            WHERE t.id = ?
        `, [ticketId], (err, transaction) => {
            if (err) return reject(err);
            if (!transaction) return reject(new Error('Ticket not found'));

            db.all(`SELECT * FROM ticket_items WHERE ticket_id = ?`, [ticketId], (err, items) => {
                if (err) return reject(err);

                // Also fetch vehicle purchase data if any
                db.get(`SELECT * FROM vehicle_purchases WHERE ticket_id = ?`, [ticketId], (err, vehicle) => {
                    if (err) return reject(err);
                    resolve({ transaction, items, vehicle: vehicle || null });
                });
            });
        });
    });
});

// --- SEARCH & UTILITY HANDLERS ---
ipcMain.handle('search-customers', (e, term) => {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM customers WHERE name LIKE ? OR vehicle_plate LIKE ? OR phone LIKE ? LIMIT 5`, 
        [`%${term}%`, `%${term}%`, `%${term}%`], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('get-products', () => {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM products ORDER BY material_name ASC`, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('add-product', (e, d) => {
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO products (material_name, price_per_lb) VALUES (?, ?)`, [d.name, d.price], function(err) {
            if (err) reject(err);
            else resolve({ success: true, id: this.lastID });
        });
    });
});

ipcMain.handle('update-product', (e, data) => {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE products SET material_name = ?, price_per_lb = ? WHERE id = ?`, 
        [data.name, data.price, data.id], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
});

ipcMain.handle('delete-product', (e, id) => {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM products WHERE id = ?`, [id], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
});

ipcMain.handle('get-transactions', () => {
    return new Promise((resolve, reject) => {
        db.all(`SELECT t.*, c.name as customer_name, c.vehicle_plate FROM transactions t JOIN customers c ON t.customer_id = c.id ORDER BY t.date DESC LIMIT 50`, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('search-transactions', (e, term) => {
    return new Promise((resolve, reject) => {
        const pattern = `%${term}%`;
        db.all(`SELECT t.*, c.name as customer_name, c.vehicle_plate FROM transactions t JOIN customers c ON t.customer_id = c.id WHERE c.name LIKE ? OR c.vehicle_plate LIKE ? OR c.id_number LIKE ? ORDER BY t.date DESC LIMIT 50`, [pattern, pattern, pattern], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

// --- ADMIN TOOLS ---
ipcMain.handle('get-db-stats', () => {
    return new Promise((resolve, reject) => {
        const stats = {};
        db.get(`SELECT COUNT(*) as count FROM customers`, (err, row) => {
            if (err) return reject(err);
            stats.customers = row.count;
            
            db.get(`SELECT COUNT(*) as count, SUM(total_amount) as total FROM transactions`, (err, row) => {
                if (err) return reject(err);
                stats.transactions = row.count;
                stats.totalRevenue = row.total || 0;
                
                db.get(`SELECT COUNT(*) as count FROM products`, (err, row) => {
                    if (err) return reject(err);
                    stats.products = row.count;
                    resolve(stats);
                });
            });
        });
    });
});

ipcMain.handle('get-detailed-report', (e, { period, reportType, filters }) => {
    return new Promise((resolve, reject) => {
        let query = `
            SELECT t.id, t.date, t.customer_id, t.transaction_type, t.total_amount, 
                   c.name as customer_name, c.phone, c.address,
                   i.material_name, i.net_weight, i.total_price,
                   COUNT(*) as item_count
            FROM transactions t
            JOIN customers c ON t.customer_id = c.id
            LEFT JOIN ticket_items i ON t.id = i.ticket_id
        `;
        
        let whereConditions = [];
        let params = [];
        
        // Date filtering
        let dateFilter = '';
        switch(period) {
            case 'hourly':
                dateFilter = `datetime('now', 'localtime', '-1 hour')`;
                break;
            case 'daily':
                dateFilter = `DATE('now', 'localtime')`;
                whereConditions.push(`DATE(t.date) = ${dateFilter}`);
                break;
            case 'weekly':
                dateFilter = `datetime('now', 'localtime', '-7 days')`;
                whereConditions.push(`t.date >= ${dateFilter}`);
                break;
            case 'monthly':
                dateFilter = `datetime('now', 'localtime', '-30 days')`;
                whereConditions.push(`t.date >= ${dateFilter}`);
                break;
            case 'quarterly':
                dateFilter = `datetime('now', 'localtime', '-90 days')`;
                whereConditions.push(`t.date >= ${dateFilter}`);
                break;
            case 'yearly':
                dateFilter = `datetime('now', 'localtime', '-365 days')`;
                whereConditions.push(`t.date >= ${dateFilter}`);
                break;
        }
        
        // Report type filtering
        let groupBy = '';
        switch(reportType) {
            case 'sales':
                whereConditions.push(`COALESCE(t.transaction_type, 'sale') = 'sale'`);
                break;
            case 'purchases':
                whereConditions.push(`COALESCE(t.transaction_type, 'sale') = 'buy'`);
                break;
            case 'product_summary':
                groupBy = ` GROUP BY i.material_name`;
                break;
            case 'product_detail':
                break;
            case 'customer':
                if (filters && filters.customerId) {
                    whereConditions.push(`t.customer_id = ?`);
                    params.push(filters.customerId);
                }
                break;
        }

        // Apply where conditions before GROUP BY
        if (whereConditions.length > 0) {
            query += ` WHERE ` + whereConditions.join(' AND ');
        }

        if (groupBy) {
            query += groupBy;
        }

        query += ` ORDER BY t.date DESC`;
        
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('get-report-summary', (e, { period, reportType }) => {
    return new Promise((resolve, reject) => {
        let dateWhere = '';
        
        switch(period) {
            case 'hourly':
                dateWhere = `t.date >= datetime('now', 'localtime', '-1 hour')`;
                break;
            case 'daily':
                dateWhere = `DATE(t.date) = DATE('now', 'localtime')`;
                break;
            case 'weekly':
                dateWhere = `t.date >= datetime('now', 'localtime', '-7 days')`;
                break;
            case 'monthly':
                dateWhere = `t.date >= datetime('now', 'localtime', '-30 days')`;
                break;
            case 'quarterly':
                dateWhere = `t.date >= datetime('now', 'localtime', '-90 days')`;
                break;
            case 'yearly':
                dateWhere = `t.date >= datetime('now', 'localtime', '-365 days')`;
                break;
        }
        
        let query = '';
        
        switch(reportType) {
            case 'sales':
                query = `
                    SELECT 
                        COUNT(*) as transaction_count,
                        SUM(t.total_amount) as total_sales,
                        AVG(t.total_amount) as avg_transaction,
                        COUNT(DISTINCT t.customer_id) as unique_customers
                    FROM transactions t
                    WHERE COALESCE(t.transaction_type, 'sale') = 'sale' AND ${dateWhere}
                `;
                break;
            case 'purchases':
                query = `
                    SELECT 
                        COUNT(*) as transaction_count,
                        SUM(t.total_amount) as total_purchases,
                        AVG(t.total_amount) as avg_transaction,
                        COUNT(DISTINCT t.customer_id) as unique_vendors
                    FROM transactions t
                    WHERE COALESCE(t.transaction_type, 'sale') = 'buy' AND ${dateWhere}
                `;
                break;
            case 'product':
                query = `
                    SELECT 
                        i.material_name,
                        SUM(i.net_weight) as total_weight,
                        SUM(i.total_price) as total_value,
                        COUNT(*) as transaction_count,
                        AVG(i.total_price / NULLIF(i.net_weight, 0)) as avg_price_per_lb
                    FROM ticket_items i
                    JOIN transactions t ON i.ticket_id = t.id
                    WHERE ${dateWhere}
                    GROUP BY i.material_name
                    ORDER BY total_value DESC
                `;
                break;
        }
        
        db.all(query, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('get-material-stats', (e, period) => {
    return new Promise((resolve, reject) => {
        const limit = period === 'daily' ? "DATE('now', 'localtime')" : "DATE('now', 'localtime', '-30 days')";
        const query = `SELECT i.material_name, SUM(i.net_weight) as total_weight, SUM(i.total_price) as total_value, COUNT(*) as transaction_count FROM ticket_items i JOIN transactions t ON i.ticket_id = t.id WHERE DATE(t.date) >= ${limit} GROUP BY i.material_name ORDER BY total_value DESC`;
        db.all(query, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('backup-database', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Database Backup',
        defaultPath: path.join(app.getPath('documents'), `SamRecycling_Backup_${new Date().toISOString().replace(/[:.]/g, '-')}.db`),
        filters: [
            { name: 'Database', extensions: ['db'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled) {
        return { success: false, message: 'Backup canceled' };
    }

    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("VACUUM", () => {
                fs.copyFile(dbPath, result.filePath, (err) => {
                    if (err) reject(err);
                    else resolve({ success: true, path: result.filePath });
                });
            });
        });
    });
});

ipcMain.handle('restore-database', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Backup to Restore',
        defaultPath: app.getPath('documents'),
        filters: [
            { name: 'Database', extensions: ['db'] },
            { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
    });

    if (result.canceled) {
        return { success: false, message: 'Restore canceled' };
    }

    const backupPath = result.filePaths[0];

    return new Promise((resolve, reject) => {
        // Close current database
        db.close((closeErr) => {
            if (closeErr) {
                console.error('Error closing DB for restore:', closeErr.message);
            }
            // Copy backup over current database
            fs.copyFile(backupPath, dbPath, (err) => {
                if (err) {
                    // Try to reopen original DB on copy failure
                    Object.assign(db, new sqlite3.Database(dbPath));
                    reject(err);
                } else {
                    resolve({ success: true, message: 'Database restored. Please restart the app.' });
                }
            });
        });
    });
});

// Voucher System
ipcMain.handle('generate-voucher', (e, { ticketId, customerId, amount }) => {
    return new Promise((resolve, reject) => {
        const voucherCode = `V${Date.now().toString().slice(-8)}`;
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
        
        db.run(
            `INSERT INTO vouchers (ticket_id, voucher_code, customer_id, amount, created_at, expires_at) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [ticketId, voucherCode, customerId, amount, createdAt, expiresAt],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, voucherId: this.lastID, voucherCode, expiresAt });
            }
        );
    });
});

ipcMain.handle('get-vouchers', (e, customerId) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM vouchers WHERE customer_id = ? ORDER BY created_at DESC`,
            [customerId],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
});

ipcMain.handle('redeem-voucher', (e, voucherCode) => {
    return new Promise((resolve, reject) => {
        const redeemedAt = new Date().toISOString();
        db.run(
            `UPDATE vouchers SET is_redeemed = 1, redeemed_at = ? WHERE voucher_code = ?`,
            [redeemedAt, voucherCode],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, changes: this.changes });
            }
        );
    });
});

// Copper Hold System
ipcMain.handle('create-copper-hold', (e, ticketId) => {
    return new Promise((resolve, reject) => {
        const holdStart = new Date();
        const holdExpiry = new Date(holdStart.getTime() + 5 * 24 * 60 * 60 * 1000); // 5 days
        
        db.run(
            `INSERT INTO copper_holds (ticket_id, hold_start, hold_expiry) 
             VALUES (?, ?, ?)`,
            [ticketId, holdStart.toISOString(), holdExpiry.toISOString()],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, holdId: this.lastID, expiryDate: holdExpiry });
            }
        );
    });
});

ipcMain.handle('get-copper-holds', () => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT ch.*, t.id as transaction_id, t.date, c.name FROM copper_holds ch
             JOIN transactions t ON ch.ticket_id = t.id
             JOIN customers c ON t.customer_id = c.id
             ORDER BY ch.is_released ASC, ch.hold_expiry ASC`,
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
});

ipcMain.handle('release-copper-hold', (e, holdId) => {
    return new Promise((resolve, reject) => {
        const releaseDate = new Date().toISOString();
        db.run(
            `UPDATE copper_holds SET is_released = 1, release_date = ? WHERE id = ?`,
            [releaseDate, holdId],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, changes: this.changes });
            }
        );
    });
});

// Vehicle Purchase Records
ipcMain.handle('save-vehicle-purchase', (e, data) => {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO vehicle_purchases (ticket_id, vin, make, model, year, color, description, condition_notes, has_title, has_registration, title_number, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
            [data.ticketId, data.vin, data.make, data.model, data.year, data.color,
             data.description, data.conditionNotes, data.hasTitle ? 1 : 0,
             data.hasRegistration ? 1 : 0, data.titleNumber || null],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, vehicleId: this.lastID });
            }
        );
    });
});

ipcMain.handle('get-vehicle-purchase', (e, ticketId) => {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM vehicle_purchases WHERE ticket_id = ?`,
            [ticketId],
            (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            }
        );
    });
});

ipcMain.handle('get-all-vehicle-purchases', () => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT vp.*, t.date, t.total_amount, t.transaction_type, c.name as customer_name, c.phone, c.vehicle_plate
             FROM vehicle_purchases vp
             JOIN transactions t ON vp.ticket_id = t.id
             JOIN customers c ON t.customer_id = c.id
             ORDER BY vp.created_at DESC`,
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
});

ipcMain.handle('update-vehicle-purchase', (e, data) => {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE vehicle_purchases SET vin=?, make=?, model=?, year=?, color=?, description=?,
             condition_notes=?, has_title=?, has_registration=?, title_number=? WHERE id=?`,
            [data.vin, data.make, data.model, data.year, data.color, data.description,
             data.conditionNotes, data.hasTitle ? 1 : 0, data.hasRegistration ? 1 : 0,
             data.titleNumber || null, data.id],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, changes: this.changes });
            }
        );
    });
});

ipcMain.handle('search-vehicles', (e, term) => {
    return new Promise((resolve, reject) => {
        const pattern = `%${term}%`;
        db.all(
            `SELECT vp.*, t.date, t.total_amount, c.name as customer_name
             FROM vehicle_purchases vp
             JOIN transactions t ON vp.ticket_id = t.id
             JOIN customers c ON t.customer_id = c.id
             WHERE vp.vin LIKE ? OR vp.make LIKE ? OR vp.model LIKE ? OR vp.description LIKE ?
             ORDER BY vp.created_at DESC`,
            [pattern, pattern, pattern, pattern],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
});

// Inventory Management
ipcMain.handle('add-inventory', (e, { materialId, quantityLbs, location }) => {
    return new Promise((resolve, reject) => {
        const dateAdded = new Date().toISOString();
        db.run(
            `INSERT INTO inventory (material_id, quantity_lbs, location, date_added) 
             VALUES (?, ?, ?, ?)`,
            [materialId, quantityLbs, location, dateAdded],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, inventoryId: this.lastID });
            }
        );
    });
});

ipcMain.handle('get-inventory', () => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT i.*, p.material_name FROM inventory i
             JOIN products p ON i.material_id = p.id
             ORDER BY p.material_name ASC`,
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
});

// Delete Inventory
ipcMain.handle('delete-inventory', (e, id) => {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM inventory WHERE id = ?`, [id], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
});

// --- TICKET EDITING HANDLERS ---

// Add a new item to an existing ticket
ipcMain.handle('add-ticket-item', (e, { ticketId, materialName, netWeight, totalPrice }) => {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO ticket_items (ticket_id, material_name, net_weight, total_price) VALUES (?, ?, ?, ?)`,
            [ticketId, materialName, netWeight, totalPrice],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, itemId: this.lastID });
            }
        );
    });
});

// Delete an item from a ticket
ipcMain.handle('delete-ticket-item', (e, itemId) => {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM ticket_items WHERE id = ?`, [itemId], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
});

// Recalculate ticket total from its items
ipcMain.handle('recalc-ticket-total', (e, ticketId) => {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT COALESCE(SUM(total_price), 0) as total FROM ticket_items WHERE ticket_id = ?`,
            [ticketId],
            (err, row) => {
                if (err) return reject(err);
                const newTotal = row.total;
                db.run(
                    `UPDATE transactions SET total_amount = ?, base_total = ? WHERE id = ?`,
                    [newTotal, newTotal, ticketId],
                    function(err2) {
                        if (err2) reject(err2);
                        else resolve({ success: true, newTotal });
                    }
                );
            }
        );
    });
});

// Save VIN area image
ipcMain.handle('save-vin-image', async (e, { vehicleId, sourcePath }) => {
    const ext = path.extname(sourcePath);
    const fileName = `vin_${vehicleId}_${Date.now()}${ext}`;
    const destPath = path.join(vinImagesPath, fileName);

    return new Promise((resolve, reject) => {
        fs.copyFile(sourcePath, destPath, (err) => {
            if (err) return reject(err);

            db.run(`UPDATE vehicle_purchases SET vin_image=? WHERE id=?`, [destPath, vehicleId], (err) => {
                if (err) reject(err);
                else resolve({ path: destPath });
            });
        });
    });
});

// Price History Tracking
ipcMain.handle('update-product-price', (e, { productId, newPrice, oldPrice }) => {
    return new Promise((resolve, reject) => {
        const changedAt = new Date().toISOString();
        
        // Update product price
        db.run(`UPDATE products SET price_per_lb = ? WHERE id = ?`,
            [newPrice, productId], function(err) {
                if (err) return reject(err);
                
                // Record in price history
                db.run(
                    `INSERT INTO price_history (material_id, old_price, new_price, changed_at, changed_by)
                     VALUES (?, ?, ?, ?, ?)`,
                    [productId, oldPrice, newPrice, changedAt, 'user'],
                    (err) => {
                        if (err) reject(err);
                        else resolve({ success: true });
                    }
                );
            }
        );
    });
});

ipcMain.handle('get-price-history', (e, materialId) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT ph.*, p.material_name FROM price_history ph
             JOIN products p ON ph.material_id = p.id
             WHERE ph.material_id = ?
             ORDER BY ph.changed_at DESC`,
            [materialId],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
});

// Customer Balance Tracking
ipcMain.handle('update-customer-balance', (e, { customerId, amount }) => {
    return new Promise((resolve, reject) => {
        const lastUpdated = new Date().toISOString();
        
        // First try to update, if no row exists, insert
        db.run(
            `INSERT INTO customer_balances (customer_id, balance, last_updated) 
             VALUES (?, ?, ?) 
             ON CONFLICT(customer_id) DO UPDATE SET balance = balance + ?, last_updated = ?`,
            [customerId, amount, lastUpdated, amount, lastUpdated],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true });
            }
        );
    });
});

ipcMain.handle('get-customer-balance', (e, customerId) => {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM customer_balances WHERE customer_id = ?`,
            [customerId],
            (err, row) => {
                if (err) reject(err);
                else resolve(row || { balance: 0 });
            }
        );
    });
});

ipcMain.handle('get-all-customer-balances', () => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT cb.*, c.name FROM customer_balances cb
             JOIN customers c ON cb.customer_id = c.id
             ORDER BY cb.balance DESC`,
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
});

// Dashboard Analytics
ipcMain.handle('get-dashboard-analytics', () => {
    return new Promise((resolve, reject) => {
        const analytics = {};
        
        // Total sales today
        db.get(`
            SELECT COUNT(*) as count, SUM(total_amount) as total 
            FROM transactions 
            WHERE COALESCE(transaction_type, 'sale') = 'sale' AND DATE(date) = DATE('now', 'localtime')
        `, (err, row) => {
            if (err) return reject(err);
            analytics.todaySales = row;
            
            // Total purchases today
            db.get(`
                SELECT COUNT(*) as count, SUM(total_amount) as total 
                FROM transactions 
                WHERE COALESCE(transaction_type, 'sale') = 'buy' AND DATE(date) = DATE('now', 'localtime')
            `, (err, row) => {
                if (err) return reject(err);
                analytics.todayPurchases = row;
                
                // Active copper holds
                db.get(`
                    SELECT COUNT(*) as count, COUNT(DISTINCT ticket_id) as tickets
                    FROM copper_holds
                    WHERE is_released = 0 AND hold_expiry > datetime('now')
                `, (err, row) => {
                    if (err) return reject(err);
                    analytics.activeCopperHolds = row;
                    
                    // Top materials this week
                    db.all(`
                        SELECT i.material_name, SUM(i.net_weight) as total_weight, 
                               SUM(i.total_price) as total_value
                        FROM ticket_items i
                        JOIN transactions t ON i.ticket_id = t.id
                        WHERE t.date >= datetime('now', '-7 days')
                        GROUP BY i.material_name
                        ORDER BY total_value DESC
                        LIMIT 5
                    `, (err, rows) => {
                        if (err) return reject(err);
                        analytics.topMaterialsWeek = rows;
                        
                        // Pending vouchers
                        db.get(`
                            SELECT COUNT(*) as count, SUM(amount) as total_amount
                            FROM vouchers
                            WHERE is_redeemed = 0 AND expires_at > datetime('now')
                        `, (err, row) => {
                            if (err) return reject(err);
                            analytics.pendingVouchers = row;
                            
                            resolve(analytics);
                        });
                    });
                });
            });
        });
    });
});

ipcMain.handle('update-dealer-exemption', (e, { customerId, isDealerExempt, dealerNumber }) => {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE customers SET dealer_exemption = ?, dealer_number = ? WHERE id = ?`,
            [isDealerExempt ? 1 : 0, dealerNumber || null, customerId],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, changes: this.changes });
            }
        );
    });
});

ipcMain.handle('get-transactions-by-type', (e, { type, days = 30 }) => {
    return new Promise((resolve, reject) => {
        const safeDays = Math.max(1, Math.min(parseInt(days, 10) || 30, 3650));
        let typeCondition = '';
        if (type === 'sales') typeCondition = `AND COALESCE(t.transaction_type, 'sale') = 'sale'`;
        if (type === 'purchases') typeCondition = `AND COALESCE(t.transaction_type, 'sale') = 'buy'`;

        const query = `
            SELECT t.*, c.name as customer_name, c.phone, c.is_vendor
            FROM transactions t
            JOIN customers c ON t.customer_id = c.id
            WHERE DATE(t.date) >= DATE('now', 'localtime', '-' || ? || ' days')
            ${typeCondition}
            ORDER BY t.date DESC
        `;

        db.all(query, [safeDays], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('get-product-detail-report', (e, { materialName, days = 30 }) => {
    return new Promise((resolve, reject) => {
        const safeDays = Math.max(1, Math.min(parseInt(days, 10) || 30, 3650));
        const query = `
            SELECT
                t.id, t.date, t.transaction_type, c.name as customer_name,
                i.material_name, i.net_weight, i.total_price, t.total_amount
            FROM ticket_items i
            JOIN transactions t ON i.ticket_id = t.id
            JOIN customers c ON t.customer_id = c.id
            WHERE i.material_name = ?
            AND DATE(t.date) >= DATE('now', 'localtime', '-' || ? || ' days')
            ORDER BY t.date DESC
        `;

        db.all(query, [materialName, safeDays], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('get-customer-purchase-history', (e, { customerId, days = 365 }) => {
    return new Promise((resolve, reject) => {
        const safeDays = Math.max(1, Math.min(parseInt(days, 10) || 365, 3650));
        const query = `
            SELECT t.*, GROUP_CONCAT(i.material_name) as materials, SUM(i.net_weight) as total_weight
            FROM transactions t
            LEFT JOIN ticket_items i ON t.id = i.ticket_id
            WHERE t.customer_id = ? AND DATE(t.date) >= DATE('now', 'localtime', '-' || ? || ' days')
            GROUP BY t.id
            ORDER BY t.date DESC
        `;

        db.all(query, [customerId, safeDays], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('mark-as-vendor', (e, { customerId, isVendor }) => {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE customers SET is_vendor = ? WHERE id = ?`,
            [isVendor ? 1 : 0, customerId],
            function(err) {
                if (err) reject(err);
                else resolve({ success: true, changes: this.changes });
            }
        );
    });
});

ipcMain.handle('export-customers', () => {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM customers ORDER BY name`, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('get-ticket-details', (e, id) => {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM ticket_items WHERE ticket_id = ?`, [id], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

ipcMain.handle('get-customer-report', (e, id) => {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT t.date, i.material_name, i.net_weight, i.total_price 
            FROM transactions t 
            JOIN ticket_items i ON t.id = i.ticket_id 
            WHERE t.customer_id = ? 
            ORDER BY t.date DESC`;
        db.all(query, [id], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
});

// ─────────────────────────────────────────────────────────
// RS-232 SCALE INTEGRATION (scale-rs232.js)
// ─────────────────────────────────────────────────────────

const { SerialPort }     = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const Store              = require('electron-store');

const VALID_BAUD_RATES = new Set([
    110, 300, 600, 1200, 2400, 4800,
    9600, 14400, 19200, 38400, 57600,
    115200, 128000, 256000
]);

function validateBaudRate(rate) {
    const n = parseInt(rate, 10);
    if (!VALID_BAUD_RATES.has(n)) {
        console.warn(`[Scale] Invalid baud rate ${rate} — falling back to 9600.`);
        return 9600;
    }
    return n;
}

const store = new Store({ name: 'scale-config' });

const DEFAULT_CONFIG = {
    portPath:     '',
    baudRate:     9600,
    dataBits:     8,
    stopBits:     1,
    parity:       'none',
    flowControl:  'none',
    delimiter:    '\n',
    pollMode:     false,
    pollInterval: 500,
    protocol:     'auto'
};

function getScaleConfig() {
    return { ...DEFAULT_CONFIG, ...store.get('scaleConfig', {}) };
}

function saveScaleConfig(cfg) {
    if (cfg.baudRate) cfg.baudRate = validateBaudRate(cfg.baudRate);
    store.set('scaleConfig', { ...getScaleConfig(), ...cfg });
}

let scalePort         = null;
let scaleParser       = null;
let reconnectTimer    = null;
let lastWeight        = null;
let isConnected       = false;
let pollIntervalTimer = null;
let retryCount        = 0;
const RETRY_BASE_MS   = 1000;
const RETRY_MAX_MS    = 60000;
const RETRY_FACTOR    = 2;

const PARSERS = {
    toledo(raw) {
        if (/\bUS\b/.test(raw)) return { weight: null, reason: 'unstable' };
        if (/\bOL\b/.test(raw)) return { weight: null, reason: 'overload' };
        const match = raw.match(/([+-])\s*(\d+\.?\d*)/);
        if (!match) return { weight: null, reason: 'no_match' };
        const val = parseFloat(match[1] === '-' ? '-' + match[2] : match[2]);
        return { weight: isNaN(val) ? null : val };
    },

    fairbanks(raw) {
        if (/^F/.test(raw.trim())) return { weight: null, reason: 'fault' };
        const match = raw.match(/-?\d+\.?\d*/);
        if (!match) return { weight: null, reason: 'no_match' };
        const val = parseFloat(match[0]);
        return { weight: isNaN(val) ? null : val };
    },

    ricelake(raw) {
        const match = raw.match(/G([+-])(\d+\.?\d*)/i);
        if (!match) return { weight: null, reason: 'no_match' };
        const val = parseFloat(match[1] === '-' ? '-' + match[2] : match[2]);
        return { weight: isNaN(val) ? null : val };
    },

    cardinal(raw) {
        if (raw.charCodeAt(0) !== 0x02 && !/^\s/.test(raw)) {
        }
        const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
        const match   = cleaned.match(/-?\d+\.?\d*/);
        if (!match) return { weight: null, reason: 'no_match' };
        const val = parseFloat(match[0]);
        return { weight: isNaN(val) ? null : val };
    },

    generic(raw) {
        let clean = raw.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
        clean = clean.replace(/\b(ST|GS|US|NET|GROSS|lb|lbs|kg|LB|KG|tare|TARE|OL|OVER)\b/gi, '');
        clean = clean.replace(/\+/g, '');
        const match = clean.match(/-?\d+\.?\d*/);
        if (!match) return { weight: null, reason: 'no_match' };
        const val = parseFloat(match[0]);
        return { weight: isNaN(val) ? null : val };
    },

    auto(raw) {
        const order = ['toledo', 'ricelake', 'cardinal', 'fairbanks', 'generic'];
        for (const name of order) {
            const result = PARSERS[name](raw);
            if (result.weight !== null) return result;
        }
        return { weight: null, reason: 'no_match' };
    }
};

function parseWeightString(raw, protocol = 'auto') {
    const parser = PARSERS[protocol] || PARSERS.auto;
    const result = parser(raw);

    if (result.weight !== null) {
        if (result.weight < -50000 || result.weight > 500000) {
            console.warn(`[Scale] Rejected out-of-range value: ${result.weight}`);
            return null;
        }
    }

    return result.weight;
}

function buildFlowControlOptions(flowControl) {
    switch (flowControl) {
        case 'hardware':
            return { rtscts: true, xon: false, xoff: false };
        case 'software':
            return { rtscts: false, xon: true, xoff: true };
        case 'none':
        default:
            return { rtscts: false, xon: false, xoff: false };
    }
}

function connectScale(windowRef) {
    if (windowRef) mainWindow = windowRef;

    const cfg = getScaleConfig();

    if (!cfg.portPath) {
        console.log('[Scale] No port configured.');
        sendStatus('unconfigured');
        return;
    }

    if (scaleParser) {
        scaleParser.removeAllListeners('data');
        scaleParser = null;
    }
    if (scalePort) {
        scalePort.unpipe();
        if (scalePort.isOpen) {
            scalePort.close(err => {
                if (err) console.warn('[Scale] Close error during reconnect:', err.message);
            });
        }
    }

    clearTimeout(reconnectTimer);

    const baudRate    = validateBaudRate(cfg.baudRate);
    const flowOpts    = buildFlowControlOptions(cfg.flowControl || 'none');
    const retryDelay  = Math.min(RETRY_BASE_MS * Math.pow(RETRY_FACTOR, retryCount), RETRY_MAX_MS);

    console.log(`[Scale] Connecting to ${cfg.portPath} @ ${baudRate} baud (attempt ${retryCount + 1}, flow: ${cfg.flowControl || 'none'}, protocol: ${cfg.protocol || 'auto'})...`);
    sendStatus('connecting', `Attempt ${retryCount + 1}`);

    try {
        scalePort = new SerialPort({
            path:     cfg.portPath,
            baudRate: baudRate,
            dataBits: cfg.dataBits  || 8,
            stopBits: cfg.stopBits  || 1,
            parity:   cfg.parity    || 'none',
            autoOpen: false,
            ...flowOpts
        });

        scaleParser = scalePort.pipe(new ReadlineParser({
            delimiter: cfg.delimiter === '\\r\\n' ? '\r\n' : (cfg.delimiter || '\n')
        }));

        scaleParser.on('data', (line) => {
            const weight = parseWeightString(line, cfg.protocol || 'auto');
            if (weight !== null) {
                lastWeight = weight;
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('scale-update', weight.toFixed(1));
                }
            }
        });

        scalePort.on('open', () => {
            console.log(`[Scale] Connected: ${cfg.portPath}`);
            isConnected = true;
            retryCount  = 0;
            sendStatus('connected');

            if (cfg.pollMode) {
                startPollMode(cfg.pollInterval || 500);
            }
        });

        scalePort.on('error', (err) => {
            console.error('[Scale] Port error:', err.message);
            isConnected = false;
            sendStatus('error', err.message);
            scheduleReconnect();
        });

        scalePort.on('close', () => {
            console.warn('[Scale] Port closed.');
            isConnected = false;
            sendStatus('disconnected');
            scheduleReconnect();
        });

        scalePort.open((err) => {
            if (err) {
                console.error('[Scale] Failed to open:', err.message);
                sendStatus('error', err.message);
                scheduleReconnect();
            }
        });

    } catch (err) {
        console.error('[Scale] Connection exception:', err.message);
        sendStatus('error', err.message);
        scheduleReconnect();
    }
}

function startPollMode(intervalMs) {
    stopPollMode();
    pollIntervalTimer = setInterval(() => {
        if (scalePort && scalePort.isOpen) {
            scalePort.write('\r', err => {
                if (err) console.warn('[Scale] Poll write error:', err.message);
            });
        }
    }, intervalMs);
}

function stopPollMode() {
    if (pollIntervalTimer) {
        clearInterval(pollIntervalTimer);
        pollIntervalTimer = null;
    }
}

function scheduleReconnect() {
    stopPollMode();
    clearTimeout(reconnectTimer);

    const base    = Math.min(RETRY_BASE_MS * Math.pow(RETRY_FACTOR, retryCount), RETRY_MAX_MS);
    const jitter  = base * 0.1 * (Math.random() * 2 - 1);
    const delay   = Math.round(base + jitter);
    retryCount++;

    console.log(`[Scale] Reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${retryCount})...`);
    sendStatus('disconnected', `Retry ${retryCount} in ${(delay / 1000).toFixed(1)}s`);

    reconnectTimer = setTimeout(() => connectScale(), delay);
}

function disconnectScale() {
    stopPollMode();
    clearTimeout(reconnectTimer);
    retryCount = 0;

    if (scaleParser) {
        scaleParser.removeAllListeners('data');
        scaleParser = null;
    }
    if (scalePort) {
        scalePort.unpipe();
    }
    if (scalePort && scalePort.isOpen) {
        scalePort.close(err => {
            if (err) console.warn('[Scale] Close error:', err.message);
        });
    }

    isConnected = false;
}

function sendStatus(status, message = '') {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scale-status', { status, message });
    }
}

ipcMain.handle('list-serial-ports', async () => {
    try {
        const ports = await SerialPort.list();
        return ports.map(p => ({
            path:         p.path,
            manufacturer: p.manufacturer || '',
            serialNumber: p.serialNumber || '',
            pnpId:        p.pnpId        || '',
            locationId:   p.locationId   || '',
            vendorId:     p.vendorId     || '',
            productId:    p.productId    || ''
        }));
    } catch (err) {
        console.error('[Scale] Port list error:', err.message);
        return [];
    }
});

ipcMain.handle('get-scale-config', () => ({
    ...getScaleConfig(),
    validBaudRates: [...VALID_BAUD_RATES].sort((a, b) => a - b)
}));

ipcMain.handle('save-scale-config', (event, cfg) => {
    saveScaleConfig(cfg);
    disconnectScale();
    clearTimeout(reconnectTimer);
    retryCount = 0;
    setTimeout(() => connectScale(), 500);
    return { ok: true };
});

ipcMain.handle('reconnect-scale', () => {
    disconnectScale();
    clearTimeout(reconnectTimer);
    retryCount = 0;
    setTimeout(() => connectScale(), 300);
    return { ok: true };
});

// ── Auto-Seek: scan all COM ports for a responding scale ──
ipcMain.handle('auto-seek-scale', async () => {
    let ports;
    try {
        ports = await SerialPort.list();
    } catch (err) {
        return { success: false, message: 'Cannot list serial ports: ' + err.message };
    }

    if (ports.length === 0) {
        return { success: false, message: 'No serial ports found on this machine.' };
    }

    const baudRatesToTry = [9600, 4800, 19200, 38400, 115200, 2400, 1200];
    const results = [];

    for (const portInfo of ports) {
        for (const baud of baudRatesToTry) {
            try {
                const result = await probePort(portInfo.path, baud);
                if (result.gotData) {
                    results.push({
                        path: portInfo.path,
                        baudRate: baud,
                        manufacturer: portInfo.manufacturer || '',
                        sampleData: result.sample,
                        parsedWeight: result.weight
                    });
                    // Found data on this port — skip other baud rates for it
                    break;
                }
            } catch (_) {
                // Port busy or inaccessible — skip
            }
        }
    }

    if (results.length === 0) {
        return {
            success: false,
            message: `Scanned ${ports.length} port(s) at ${baudRatesToTry.length} baud rates — no scale responded.`,
            portsScanned: ports.map(p => p.path)
        };
    }

    // Pick the best result (prefer one with a parsed weight)
    const best = results.find(r => r.parsedWeight !== null) || results[0];

    return {
        success: true,
        message: `Found scale on ${best.path} @ ${best.baudRate} baud`,
        port: best.path,
        baudRate: best.baudRate,
        manufacturer: best.manufacturer,
        sample: best.sampleData,
        weight: best.parsedWeight,
        allResults: results
    };
});

function probePort(portPath, baudRate) {
    return new Promise((resolve, reject) => {
        const timeout = 3000; // 3 seconds per probe
        let settled = false;

        const port = new SerialPort({
            path: portPath,
            baudRate: baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            autoOpen: false
        });

        const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
        let timer;

        function cleanup(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            parser.removeAllListeners('data');
            port.unpipe();
            if (port.isOpen) {
                port.close(() => {});
            }
            if (result) resolve(result);
            else reject(new Error('timeout'));
        }

        parser.on('data', (line) => {
            const trimmed = (line || '').toString().trim();
            if (trimmed.length < 2) return; // Noise — keep waiting

            const weight = parseWeightString(trimmed, 'auto');
            cleanup({
                gotData: true,
                sample: trimmed.substring(0, 80),
                weight: weight
            });
        });

        port.on('error', (err) => cleanup(null));

        port.open((err) => {
            if (err) return cleanup(null);

            // Also try a poll command (some scales need a request)
            setTimeout(() => {
                if (!settled && port.isOpen) {
                    port.write('\r', () => {});
                }
            }, 500);

            timer = setTimeout(() => cleanup({ gotData: false, sample: null, weight: null }), timeout);
        });
    });
}

ipcMain.handle('get-scale-status', () => ({
    connected:  isConnected,
    port:       getScaleConfig().portPath,
    retryCount,
    lastWeight
}));

app.on('before-quit', () => disconnectScale());

app.on('window-all-closed', () => { 
    if (process.platform !== 'darwin') app.quit(); 
});
