'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Allowlist of all IPC channels the renderer is permitted to call.
const ALLOWED_CHANNELS = [
    'add-split-ticket',
    'get-all-customers',
    'create-customer-profile',
    'save-customer-profile',
    'save-dl-image',
    'save-location-image',
    'search-customers',
    'get-products',
    'add-product',
    'update-product',
    'delete-product',
    'get-transactions',
    'search-transactions',
    'get-db-stats',
    'get-sales-summary',
    'get-material-stats',
    'backup-database',
    'restore-database',
    'export-customers',
    'get-ticket-details',
    'get-ticket-details-with-customer',
    'get-customer-report',
    'get-detailed-report',
    'get-report-summary',
    'update-dealer-exemption',
    'get-transactions-by-type',
    'get-product-detail-report',
    'get-customer-purchase-history',
    'mark-as-vendor',
    'update-ticket-price',
    'update-ticket-item-price',
    // Scale-related
    'list-serial-ports',
    'get-scale-config',
    'save-scale-config',
    'reconnect-scale',
    'get-scale-status',
    'auto-seek-scale',
    // Vehicle Purchases
    'save-vehicle-purchase',
    'get-vehicle-purchase',
    'get-all-vehicle-purchases',
    'update-vehicle-purchase',
    'search-vehicles',
    // Voucher and Copper Hold
    'generate-voucher',
    'get-vouchers',
    'redeem-voucher',
    'create-copper-hold',
    'get-copper-holds',
    'release-copper-hold',
    // Reporting
    'get-detailed-report',
    'get-report-summary',
    // Inventory & Pricing
    'add-inventory',
    'get-inventory',
    'update-product-price',
    'get-price-history',
    // Customer Balances
    'update-customer-balance',
    'get-customer-balance',
    'get-all-customer-balances',
    // Analytics
    'get-dashboard-analytics'
];

contextBridge.exposeInMainWorld('electronAPI', {
    invoke: (channel, ...args) => {
        if (!ALLOWED_CHANNELS.includes(channel)) {
            return Promise.reject(new Error(`IPC channel "${channel}" is not allowed`));
        }
        return ipcRenderer.invoke(channel, ...args);
    },
    // Scale update listener (legacy name used by standalone split-weigh)
    onScaleUpdate: (cb) => {
        ipcRenderer.removeAllListeners('scale-update');
        ipcRenderer.on('scale-update', (_, w) => cb(w));
    },
    // Scale weight listener (used by renderer.js)
    onScaleWeight: (cb) => {
        ipcRenderer.removeAllListeners('scale-update');
        ipcRenderer.on('scale-update', (_, w) => cb(w));
    },
    // Scale status listener
    onScaleStatus: (cb) => {
        ipcRenderer.removeAllListeners('scale-status');
        ipcRenderer.on('scale-status', (_, s) => cb(s));
    }
});
