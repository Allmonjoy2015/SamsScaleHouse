// Note: We removed the 'require(electron)' line here because preload.js handles it now!

let productsList = [];
let crmCustomers = [];
let currentTargetId = null, currentRowId = null, customerSearchTimeout = null;
let currentFocusedRowId = null;
let lastScaleWeight = 0;

function showView(v) {
    document.querySelectorAll('.view-section').forEach(el => el.style.display = 'none');
    document.getElementById(v).style.display = 'block';
    document.querySelectorAll('.nav-item').forEach(btn => btn.classList.toggle('active', btn.getAttribute('onclick').includes(v)));
}

// --- 1. TICKET: CUSTOMER AUTOFILL & WARNING ---
async function handleCustomerSearch(val) {
    clearTimeout(customerSearchTimeout);
    const alertBanner = document.getElementById('dlAlertBanner');
    alertBanner.style.display = 'none';
    const dropdown = document.getElementById('customerDropdown');

    if (val.trim().length < 2) {
        dropdown.style.display = 'none';
        return;
    }

    customerSearchTimeout = setTimeout(async () => {
        try {
            const matches = await window.electronAPI.invoke('search-customers', val);
            if (matches.length > 0) {
                dropdown.innerHTML = '';
                matches.forEach(c => {
                    const item = document.createElement('div');
                    item.style.cssText = 'padding:10px 12px; cursor:pointer; border-bottom:1px solid #eee; font-size:14px;';
                    item.onmouseenter = () => item.style.background = '#e8f4ff';
                    item.onmouseleave = () => item.style.background = '#fff';
                    const name = c.name || 'Unknown';
                    const phone = c.phone ? ` — ${c.phone}` : '';
                    const id = c.id_number ? ` — ID: ${c.id_number}` : '';
                    const plate = c.vehicle_plate ? ` — ${c.vehicle_plate}` : '';
                    item.textContent = `${name}${phone}${id}${plate}`;
                    item.onclick = () => selectCustomer(c);
                    dropdown.appendChild(item);
                });
                dropdown.style.display = 'block';
            } else {
                dropdown.innerHTML = '<div style="padding:10px 12px; color:#888; font-size:13px;">No matching customers found</div>';
                dropdown.style.display = 'block';
            }
        } catch (err) {
            console.error("Search error:", err);
            dropdown.style.display = 'none';
        }
    }, 300);
}

function selectCustomer(c) {
    const dropdown = document.getElementById('customerDropdown');
    dropdown.style.display = 'none';

    document.getElementById('custName').value = c.name || '';
    document.getElementById('custId').value = c.id_number || '';
    document.getElementById('custPlate').value = c.truck_description ? `${c.truck_description} (${c.vehicle_plate})` : c.vehicle_plate || '';

    // Check Expiration Date
    const alertBanner = document.getElementById('dlAlertBanner');
    if (c.dl_expiration) {
        const expDate = new Date(c.dl_expiration);
        const diffDays = Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) {
            alertBanner.className = 'alert-banner alert-danger';
            alertBanner.innerHTML = `🚨 WARNING: Driver's License Expired on ${expDate.toLocaleDateString()}! Update required.`;
            alertBanner.style.display = 'block';
        } else if (diffDays <= 30) {
            alertBanner.className = 'alert-banner alert-warning';
            alertBanner.innerHTML = `⚠️ NOTICE: Driver's License expires in ${diffDays} days (${expDate.toLocaleDateString()}).`;
            alertBanner.style.display = 'block';
        }
    }
}

// Close customer dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('customerDropdown');
    const input = document.getElementById('custName');
    if (dropdown && !dropdown.contains(e.target) && e.target !== input) {
        dropdown.style.display = 'none';
    }
});

// --- 2. TICKET: ENGINE ---
async function initTicketView() {
    await loadProducts();
    document.getElementById('dlAlertBanner').style.display = 'none';
    // Remove any vehicle info panels before clearing rows
    document.querySelectorAll('.vehicle-info-row').forEach(el => el.remove());
    document.getElementById('splitWeighingBody').innerHTML = '';
    document.getElementById('grandTotalDisplay').innerText = '0.00';
    addSplitRow(false);
    document.getElementById('custName').focus();
}

function addSplitRow(focusNewRow = true) {
    const rid = Date.now();
    let opts = productsList.map(p => `<option value="${p.price_per_lb}">${p.material_name}</option>`).join('');
    const tr = document.createElement('tr');
    tr.id = `row-${rid}`; 
    tr.className = 'split-row';
    tr.setAttribute('data-row-id', rid);
    tr.innerHTML = `<td><select class="mat-select" onchange="calculateRow('${rid}', 'material-change')" onfocus="currentFocusedRowId='${rid}'"><option value="0">Select...</option>${opts}</select></td><td><div style="display:flex; gap:3px;"><input type="number" class="gross" id="g-${rid}" oninput="calculateRow('${rid}', 'weight')" onfocus="currentFocusedRowId='${rid}'" placeholder="0.0"><button class="btn-action" onclick="openAxleModal('g-${rid}', '${rid}')" title="Axle calculator">🧮</button><button class="btn-action" onclick="captureScaleToField('g-${rid}')" title="Capture scale" style="background:#d4edda; color:#155724; font-weight:bold; padding:6px;">📊</button></div></td><td><div style="display:flex; gap:3px;"><input type="number" class="tare" id="t-${rid}" oninput="calculateRow('${rid}', 'weight')" onfocus="currentFocusedRowId='${rid}'" placeholder="0.0"><button class="btn-action" onclick="openAxleModal('t-${rid}', '${rid}')" title="Axle calculator">🧮</button><button class="btn-action" onclick="captureScaleToField('t-${rid}')" title="Capture scale" style="background:#d4edda; color:#155724; font-weight:bold; padding:6px;">📊</button></div></td><td><input type="number" class="net" readonly style="background:#eee; border:none; font-weight:bold; text-align:center;"></td><td><input type="number" class="price" oninput="this.dataset.manualOverride='true'; calculateRow('${rid}', 'price')" onfocus="currentFocusedRowId='${rid}'" placeholder="0.00" style="text-align:center; padding:8px; border:1px solid #ffb347; border-radius:4px; background:#fffaf0; font-weight:bold; color:#d97706;"></td><td><input type="number" class="total" readonly style="background:#eee; border:none; font-weight:bold; text-align:center; color:green;"></td><td><button onclick="this.closest('tr').remove(); calculateGrandTotal();" style="color:red; border:none; background:none; cursor:pointer; font-size:20px;" title="Delete">✖</button></td>`;
    document.getElementById('splitWeighingBody').appendChild(tr);
    if (focusNewRow) {
        requestAnimationFrame(() => {
            const grossInput = document.getElementById(`g-${rid}`);
            if (grossInput) {
                grossInput.focus();
                currentFocusedRowId = rid;
            }
        });
    }
}

function calculateRow(id, source) {
    const r = document.getElementById(`row-${id}`);
    if (!r) return;

    const g = parseFloat(r.querySelector('.gross').value) || 0;
    const t = parseFloat(r.querySelector('.tare').value) || 0;
    const priceInput = r.querySelector('.price');
    const matSelect = r.querySelector('.mat-select');
    const selectPrice = parseFloat(matSelect.value) || 0;
    const manualPrice = parseFloat(priceInput.value) || 0;

    // Determine price without clobbering what the user is actively typing
    let finalPrice;
    if (source === 'material-change') {
        // Material changed — apply the new material's price
        finalPrice = selectPrice;
        priceInput.dataset.manualOverride = '';
        priceInput.value = finalPrice ? finalPrice.toFixed(2) : '';
    } else if (source === 'price') {
        // User is typing in price field — do NOT overwrite it
        finalPrice = manualPrice;
    } else {
        // Weight field changed, scale capture, axle apply, etc.
        finalPrice = (priceInput.dataset.manualOverride === 'true')
            ? manualPrice
            : (manualPrice !== 0 ? manualPrice : selectPrice);
    }

    const net = Math.max(0, g - t);
    r.querySelector('.net').value = net.toFixed(2);
    r.querySelector('.total').value = (net * finalPrice).toFixed(2);

    calculateGrandTotal();
    checkCopperHold();

    // Show/hide vehicle info panel when material changes
    if (source === 'material-change') {
        checkVehicleFields(id);
    }
}

function calculateGrandTotal() {
    let sum = 0; document.querySelectorAll('.split-row .total').forEach(i => sum += parseFloat(i.value) || 0);
    document.getElementById('grandTotalDisplay').innerText = sum.toFixed(2);
}

function captureScaleToField(fieldId) {
    if (lastScaleWeight <= 0) {
        showToast('⚠️ No weight captured from scale yet.', true);
        return;
    }
    
    const field = document.getElementById(fieldId);
    if (!field) {
        showToast('❌ Field not found.', true);
        return;
    }
    
    field.value = lastScaleWeight.toFixed(2);
    field.focus();
    
    // Get the row ID and recalculate
    const row = field.closest('.split-row');
    if (row) {
        const rowId = row.id.replace('row-', '');
        calculateRow(rowId);
    }
    
    showToast(`✅ Captured ${lastScaleWeight.toFixed(2)} lbs`);
}

function showToast(msg, isError = false) {
    const el = document.getElementById('appToast');
    if (!el) {
        // Create toast if it doesn't exist
        const toast = document.createElement('div');
        toast.id = 'appToast';
        toast.style.cssText = 'display:none; position:fixed; bottom:20px; right:20px; padding:15px 25px; background:#27ae60; color:white; border-radius:6px; font-weight:bold; z-index:999;';
        document.body.appendChild(toast);
        return showToast(msg, isError);
    }
    
    el.textContent = msg;
    el.style.background = isError ? '#e74c3c' : '#27ae60';
    el.style.display = 'block';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 4500);
}

// --- 7. COPPER HOLD & VOUCHER SYSTEM ---

let currentTransactionType = 'buy'; // Default: purchase scrap

// --- VEHICLE PURCHASE FIELDS ---

const VEHICLE_MATERIAL_KEYWORDS = ['whole vehicle', 'car', 'truck', 'van', 'suv', 'auto', 'vehicle'];

function isVehicleMaterial(materialName) {
    if (!materialName) return false;
    const lower = materialName.toLowerCase();
    return VEHICLE_MATERIAL_KEYWORDS.some(kw => lower.includes(kw));
}

function checkVehicleFields(rowId) {
    const row = document.getElementById(`row-${rowId}`);
    if (!row) return;

    const sel = row.querySelector('.mat-select');
    const materialName = sel.selectedIndex > 0 ? sel.options[sel.selectedIndex].text : '';
    const vehiclePanelId = `vehicle-panel-${rowId}`;
    let panel = document.getElementById(vehiclePanelId);

    if (isVehicleMaterial(materialName)) {
        if (!panel) {
            panel = document.createElement('tr');
            panel.id = vehiclePanelId;
            panel.className = 'vehicle-info-row';
            panel.innerHTML = `
                <td colspan="7" style="padding:15px; background:#e8f4fd; border-left:4px solid #3498db;">
                    <div style="margin-bottom:8px; font-weight:bold; color:#2c3e50;">🚗 Vehicle Information</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:10px;">
                        <div>
                            <label style="font-size:10px; font-weight:bold; color:#666; text-transform:uppercase;">VIN Number</label>
                            <input type="text" class="vin-input" placeholder="17-character VIN" maxlength="17" style="width:100%; padding:8px; border:1px solid #3498db; border-radius:4px; font-family:monospace; text-transform:uppercase;">
                        </div>
                        <div>
                            <label style="font-size:10px; font-weight:bold; color:#666; text-transform:uppercase;">Year</label>
                            <input type="text" class="veh-year" placeholder="e.g. 2015" maxlength="4" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
                        </div>
                        <div>
                            <label style="font-size:10px; font-weight:bold; color:#666; text-transform:uppercase;">Make</label>
                            <input type="text" class="veh-make" placeholder="e.g. Ford" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
                        </div>
                        <div>
                            <label style="font-size:10px; font-weight:bold; color:#666; text-transform:uppercase;">Model</label>
                            <input type="text" class="veh-model" placeholder="e.g. F-150" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr 2fr; gap:10px; margin-top:10px;">
                        <div>
                            <label style="font-size:10px; font-weight:bold; color:#666; text-transform:uppercase;">Color</label>
                            <input type="text" class="veh-color" placeholder="e.g. Red" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
                        </div>
                        <div>
                            <label style="font-size:10px; font-weight:bold; color:#666; text-transform:uppercase;">Overall Condition</label>
                            <select class="veh-condition" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
                                <option value="">Select...</option>
                                <option value="Running - Good">Running - Good</option>
                                <option value="Running - Fair">Running - Fair</option>
                                <option value="Running - Poor">Running - Poor</option>
                                <option value="Non-Running - Complete">Non-Running - Complete</option>
                                <option value="Non-Running - Incomplete">Non-Running - Incomplete</option>
                                <option value="Salvage - Heavy Damage">Salvage - Heavy Damage</option>
                                <option value="Shell / Frame Only">Shell / Frame Only</option>
                            </select>
                        </div>
                        <div>
                            <label style="font-size:10px; font-weight:bold; color:#666; text-transform:uppercase;">Description / Notes</label>
                            <input type="text" class="veh-description" placeholder="e.g. Missing engine, body rust, etc." style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
                        </div>
                    </div>
                    <div style="display:flex; gap:20px; margin-top:10px; align-items:center; padding:10px; background:white; border-radius:4px; border:1px solid #ddd;">
                        <label style="display:flex; align-items:center; gap:6px; font-weight:bold; font-size:12px;">
                            <input type="checkbox" class="veh-has-title"> Title Available
                        </label>
                        <div class="veh-title-num-wrap" style="display:none;">
                            <input type="text" class="veh-title-number" placeholder="Title #" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px; width:180px;">
                        </div>
                        <label style="display:flex; align-items:center; gap:6px; font-weight:bold; font-size:12px;">
                            <input type="checkbox" class="veh-has-reg"> Registration Available
                        </label>
                        <span class="veh-doc-warning" style="color:#e74c3c; font-weight:bold; font-size:12px; display:none;">⚠️ No title or registration on file</span>
                    </div>
                </td>
            `;
            row.after(panel);

            // Wire up title checkbox toggle
            const titleCheck = panel.querySelector('.veh-has-title');
            const regCheck = panel.querySelector('.veh-has-reg');
            const titleNumWrap = panel.querySelector('.veh-title-num-wrap');
            const docWarning = panel.querySelector('.veh-doc-warning');

            titleCheck.addEventListener('change', () => {
                titleNumWrap.style.display = titleCheck.checked ? 'inline-block' : 'none';
                docWarning.style.display = (!titleCheck.checked && !regCheck.checked) ? 'inline' : 'none';
            });
            regCheck.addEventListener('change', () => {
                docWarning.style.display = (!titleCheck.checked && !regCheck.checked) ? 'inline' : 'none';
            });

            // Show warning initially
            docWarning.style.display = 'inline';
        }
    } else {
        // Not a vehicle material — remove the panel if it exists
        if (panel) panel.remove();
    }
}

function getVehicleDataFromRow(rowId) {
    const panel = document.getElementById(`vehicle-panel-${rowId}`);
    if (!panel) return null;

    return {
        vin: (panel.querySelector('.vin-input').value || '').trim().toUpperCase(),
        year: (panel.querySelector('.veh-year').value || '').trim(),
        make: (panel.querySelector('.veh-make').value || '').trim(),
        model: (panel.querySelector('.veh-model').value || '').trim(),
        color: (panel.querySelector('.veh-color').value || '').trim(),
        conditionNotes: (panel.querySelector('.veh-condition').value || '').trim(),
        description: (panel.querySelector('.veh-description').value || '').trim(),
        hasTitle: panel.querySelector('.veh-has-title').checked,
        hasRegistration: panel.querySelector('.veh-has-reg').checked,
        titleNumber: (panel.querySelector('.veh-title-number').value || '').trim()
    };
}

// Check if current ticket contains copper materials (purchase mode)
function checkCopperHold() {
    const copperSection = document.getElementById('copperExemptionSection');
    if (!copperSection) return;

    if (currentTransactionType !== 'buy') return;

    let hasCopperMaterial = false;
    document.querySelectorAll('.split-row .mat-select').forEach(sel => {
        if (sel.selectedIndex > 0 && sel.options[sel.selectedIndex].text.toLowerCase().includes('copper')) {
            hasCopperMaterial = true;
        }
    });

    // Visual indicator only — the actual hold logic runs at submit time
    if (hasCopperMaterial) {
        copperSection.style.borderColor = '#e74c3c';
    } else {
        copperSection.style.borderColor = '#ff6b00';
    }
}

async function submitSplitTicket() {
    const btn = document.getElementById('submitBtn'), materials = [];
    document.querySelectorAll('.split-row').forEach(row => {
        const sel = row.querySelector('.mat-select');
        const net = parseFloat(row.querySelector('.net').value) || 0;
        const gross = parseFloat(row.querySelector('.gross').value) || 0;
        const total = parseFloat(row.querySelector('.total').value) || 0;
        const materialName = sel.selectedIndex > 0 ? sel.options[sel.selectedIndex].text : '';

        // Keep the row if it has ANY data — weight or material
        if (materialName || gross > 0 || net > 0) {
            materials.push({
                material: materialName || 'Unspecified',
                net: net,
                total: total
            });
        }
    });
    const custName = document.getElementById('custName').value.trim();
    const data = {
        customer_name: custName || 'Walk-in',
        id_number: document.getElementById('custId').value.trim(),
        vehicle_plate: document.getElementById('custPlate').value.trim(),
        total_amount: parseFloat(document.getElementById('grandTotalDisplay').innerText),
        materials,
        transaction_type: currentTransactionType
    };
    if(materials.length === 0) return alert("Please add at least one material or weight entry");
    
    btn.disabled = true;
    btn.innerText = "SAVING...";
    try {
        const result = await window.electronAPI.invoke('add-split-ticket', data);
        
        // Check for copper in materials
        const hasCopperPurchase = currentTransactionType === 'buy' && materials.some(m => m.material.includes('Copper'));
        
        if (hasCopperPurchase) {
            // Create copper hold (unless exempted)
            const dealerExemption = document.getElementById('dealerExemption')?.checked;
            if (!dealerExemption) {
                await window.electronAPI.invoke('create-copper-hold', result.ticketId);
                alert("Copper purchase recorded.\n\n⚠️ 5-DAY HOLD APPLIED per Tennessee Law\n\nGenerating payment voucher...");
            } else {
                alert("Copper purchase recorded with DEALER EXEMPTION");
            }
            
            // Generate voucher
            const voucherResult = await window.electronAPI.invoke('generate-voucher', {
                ticketId: result.ticketId,
                customerId: null,
                amount: data.total_amount
            });
            
            // Print voucher
            printPaymentVoucher(result.ticketId, voucherResult.voucherCode, data.total_amount, data.customer_name);
        }
        
        // Save vehicle purchase data for any vehicle-type material rows
        const vehicleRows = document.querySelectorAll('.vehicle-info-row');
        for (const vRow of vehicleRows) {
            const rowId = vRow.id.replace('vehicle-panel-', '');
            const vehData = getVehicleDataFromRow(rowId);
            if (vehData && (vehData.vin || vehData.make || vehData.model)) {
                try {
                    vehData.ticketId = result.ticketId;
                    await window.electronAPI.invoke('save-vehicle-purchase', vehData);
                } catch (vErr) {
                    console.error('Error saving vehicle data:', vErr);
                }
            }
        }

        alert("Transaction Completed Successfully!");
        document.getElementById('custName').value = ''; document.getElementById('custId').value = ''; document.getElementById('custPlate').value = '';
        await initTicketView();
        document.getElementById('custName').focus();
        loadTransactions(); 
    } catch(e) { 
        console.error('Error saving transaction:', e);
        alert("Error: " + e.message); 
    } finally { 
        btn.disabled = false; 
        btn.innerText = "COMPLETE TRANSACTION";
    }
}

// Copper Hold Exemption
function toggleCopperExemption() {
    const exemptBox = document.getElementById('dealerExemption');
    const dealerNumField = document.getElementById('dealerNumber');
    if (exemptBox && dealerNumField) {
        dealerNumField.style.display = exemptBox.checked ? 'block' : 'none';
    }
}

// Payment Voucher
function printPaymentVoucher(ticketId, voucherCode, amount, customerName) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    
    const voucherHTML = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: #f9f9f9; border: 3px solid #ff6b00;">
        <div style="text-align: center; border-bottom: 3px double #ff6b00; padding-bottom: 20px;">
            <h1 style="margin: 0; color: #ff6b00;">PAYMENT VOUCHER</h1>
            <p style="margin: 5px 0; color: #666;">⚠️ 5-DAY COPPER HOLD - TENNESSEE LAW</p>
        </div>
        
        <div style="margin: 20px 0; padding: 15px; background: white; border: 1px solid #ddd;">
            <table style="width: 100%; border-collapse: collapse;">
                <tr>
                    <td style="font-weight: bold; padding: 8px;">Voucher Code:</td>
                    <td style="padding: 8px; font-family: monospace; font-size: 18px; color: #ff6b00;">${voucherCode}</td>
                </tr>
                <tr style="background: #f9f9f9;">
                    <td style="font-weight: bold; padding: 8px;">Ticket ID:</td>
                    <td style="padding: 8px;">#${ticketId}</td>
                </tr>
                <tr>
                    <td style="font-weight: bold; padding: 8px;">Vendor Name:</td>
                    <td style="padding: 8px;">${customerName}</td>
                </tr>
                <tr style="background: #f9f9f9;">
                    <td style="font-weight: bold; padding: 8px;">Amount:</td>
                    <td style="padding: 8px; font-size: 16px; color: #27ae60; font-weight: bold;">$${amount.toFixed(2)}</td>
                </tr>
                <tr>
                    <td style="font-weight: bold; padding: 8px;">Hold Period:</td>
                    <td style="padding: 8px;">5 Business Days</td>
                </tr>
                <tr style="background: #f9f9f9;">
                    <td style="font-weight: bold; padding: 8px;">Expires:</td>
                    <td style="padding: 8px;">${expiryDate.toLocaleDateString()}</td>
                </tr>
            </table>
        </div>
        
        <div style="margin: 20px 0; padding: 15px; background: #fff3cd; border-left: 5px solid #ff6b00;">
            <p style="margin: 0; font-size: 12px; color: #333;">
                <strong>IMPORTANT:</strong> This voucher must be redeemed within 30 days. 
                Copper items are held for 5 days per Tennessee scrap dealer regulations. 
                The vendor may not sell, transfer, or remove items during this hold period.
            </p>
        </div>
        
        <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 12px;">
            <p>Printed: ${new Date().toLocaleString()}</p>
            <p>Keep this voucher in a safe place</p>
        </div>
    </div>
    `;
    
    const printWindow = window.open('', '', 'width=800,height=600');
    printWindow.document.write(voucherHTML);
    printWindow.document.close();
    printWindow.print();
}

// --- 8. COMPREHENSIVE REPORTING ---

async function generateReport(period, reportType) {
    try {
        const summary = await window.electronAPI.invoke('get-report-summary', { period, reportType });
        const details = await window.electronAPI.invoke('get-detailed-report', { period, reportType, filters: {} });
        
        printReport(period, reportType, summary, details);
    } catch (error) {
        console.error('Error generating report:', error);
        alert('Error generating report');
    }
}

function printReport(period, reportType, summary, details) {
    let reportHTML = `
    <div style="font-family: Arial, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px;">
        <h1 style="text-align: center; border-bottom: 3px solid #333;">
            ${reportType.toUpperCase()} REPORT - ${period.toUpperCase()}
        </h1>
        <p style="text-align: center; color: #666; margin-top: 10px;">Generated: ${new Date().toLocaleString()}</p>
    `;
    
    // Summary Section
    if (summary && summary.length > 0) {
        reportHTML += `<h2 style="margin-top: 30px; border-bottom: 2px solid #333; padding-bottom: 10px;">SUMMARY</h2>`;
        reportHTML += `<table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">`;
        reportHTML += `<tr style="background: #f0f0f0;">`;
        Object.keys(summary[0]).forEach(key => {
            reportHTML += `<th style="padding: 10px; text-align: left; border: 1px solid #ddd;">${key}</th>`;
        });
        reportHTML += `</tr>`;
        
        summary.forEach(row => {
            reportHTML += `<tr>`;
            Object.entries(row).forEach(([key, val]) => {
                const isCurrency = key === 'total_sales' || key === 'total_purchases' || key === 'total_amount';
                const displayVal = typeof val === 'number'
                    ? (isCurrency ? `$${val.toFixed(2)}` : val.toFixed(2))
                    : val;
                reportHTML += `<td style="padding: 10px; border: 1px solid #ddd;">${displayVal}</td>`;
            });
            reportHTML += `</tr>`;
        });
        reportHTML += `</table>`;
    }
    
    // Details Section
    if (details && details.length > 0) {
        reportHTML += `<h2 style="margin-top: 30px; border-bottom: 2px solid #333; padding-bottom: 10px;">DETAILS</h2>`;
        reportHTML += `<table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px;">`;
        reportHTML += `<tr style="background: #f0f0f0;">`;
        Object.keys(details[0]).forEach(key => {
            reportHTML += `<th style="padding: 8px; text-align: left; border: 1px solid #ddd;">${key}</th>`;
        });
        reportHTML += `</tr>`;
        
        details.forEach(row => {
            reportHTML += `<tr>`;
            Object.values(row).forEach(val => {
                const displayVal = typeof val === 'number' ? 
                    (String(val).includes('.') ? val.toFixed(2) : val) : 
                    val;
                reportHTML += `<td style="padding: 8px; border: 1px solid #ddd;">${displayVal}</td>`;
            });
            reportHTML += `</tr>`;
        });
        reportHTML += `</table>`;
    }
    
    reportHTML += `<p style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">End of Report</p></div>`;
    
    const printWindow = window.open('', '', 'width=1000,height=800');
    printWindow.document.write(reportHTML);
    printWindow.document.close();
    printWindow.print();
}

// Print ticket from live view
function printLiveTicket() {
    const customerName = document.getElementById('custName').value;
    const customerId = document.getElementById('custId').value;
    const plate = document.getElementById('custPlate').value;
    const materials = [];
    let total = 0;
    
    document.querySelectorAll('.split-row').forEach(row => {
        const sel = row.querySelector('.mat-select');
        const net = parseFloat(row.querySelector('.net').value) || 0;
        const itemTotal = parseFloat(row.querySelector('.total').value) || 0;
        
        if (sel.selectedIndex > 0 && net > 0) {
            materials.push({
                material: sel.options[sel.selectedIndex].text,
                weight: net,
                price: itemTotal
            });
            total += itemTotal;
        }
    });
    
    if (materials.length === 0) {
        return alert('No materials to print');
    }
    
    const ticketHTML = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px;">LIVE TICKET</h2>
        
        <div style="margin: 20px 0;">
            <p><strong>Customer:</strong> ${customerName}</p>
            <p><strong>ID:</strong> ${customerId}</p>
            <p><strong>Vehicle:</strong> ${plate}</p>
            <p><strong>Date/Time:</strong> ${new Date().toLocaleString()}</p>
        </div>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <thead>
                <tr style="background: #f0f0f0; border-bottom: 2px solid #333;">
                    <th style="padding: 10px; text-align: left;">Material</th>
                    <th style="padding: 10px; text-align: center;">Weight (lbs)</th>
                    <th style="padding: 10px; text-align: right;">Price</th>
                </tr>
            </thead>
            <tbody>
                ${materials.map(m => `
                    <tr style="border-bottom: 1px solid #ddd;">
                        <td style="padding: 10px;">${m.material}</td>
                        <td style="padding: 10px; text-align: center;">${m.weight}</td>
                        <td style="padding: 10px; text-align: right;">$${m.price.toFixed(2)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
        
        <div style="border-top: 2px solid #333; padding-top: 10px; text-align: right;">
            <h3 style="margin: 10px 0;">TOTAL: $${total.toFixed(2)}</h3>
        </div>
        
        <p style="text-align: center; color: #666; font-size: 12px; margin-top: 20px;">Not yet submitted - for preview only</p>
    </div>
    `;
    
    const printWindow = window.open('', '', 'width=800,height=600');
    printWindow.document.write(ticketHTML);
    printWindow.document.close();
    printWindow.print();
}

// Axle Modal
function openAxleModal(tid, rid) { currentTargetId = tid; currentRowId = rid; document.getElementById('axle1').value=''; document.getElementById('axle2').value=''; document.getElementById('axle3').value=''; document.getElementById('axleTotal').innerText='0'; document.getElementById('axleModal').style.display='block'; setTimeout(()=>document.getElementById('axle1').focus(),50); }
function updateAxleTotal() { document.getElementById('axleTotal').innerText = (parseFloat(document.getElementById('axle1').value)||0) + (parseFloat(document.getElementById('axle2').value)||0) + (parseFloat(document.getElementById('axle3').value)||0); }
function applyAxleWeight() { if(currentTargetId) { document.getElementById(currentTargetId).value = document.getElementById('axleTotal').innerText; calculateRow(currentRowId); } document.getElementById('axleModal').style.display='none'; }

// --- 3. CRM ENGINE ---
async function loadCrmCustomers() {
    try {
        crmCustomers = await window.electronAPI.invoke('get-all-customers');
        renderCrmList(crmCustomers);
    } catch (error) {
        console.error('Error loading CRM customers:', error);
    }
}

function renderCrmList(list) {
    const container = document.getElementById('crmList');
    container.innerHTML = list.map(c => {
        let badge = '';
        if (c.dl_expiration) {
            const diff = Math.ceil((new Date(c.dl_expiration) - new Date()) / (1000 * 60 * 60 * 24));
            if (diff <= 0) badge = `<span style="color:red; font-size:10px; font-weight:bold; background:#fadbd8; padding:2px 5px; border-radius:3px;">EXPIRED</span>`;
            else if (diff <= 30) badge = `<span style="color:orange; font-size:10px; font-weight:bold; background:#fcf3cf; padding:2px 5px; border-radius:3px;">EXP SOON</span>`;
        }
        return `<div style="padding:12px; border-bottom:1px solid #eee; cursor:pointer; transition:0.2s;" onclick="selectCrmCustomer(${c.id})" onmouseover="this.style.background='#f9f9f9'" onmouseout="this.style.background='transparent'">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong>${c.name}</strong> ${badge}
            </div>
            <small style="color:#888;">${c.phone || 'No Phone'} | Tickets: ${c.ticket_count}</small>
        </div>`;
    }).join('');
}

function filterCrmList(term) {
    const t = term.toLowerCase();
    renderCrmList(crmCustomers.filter(c => c.name.toLowerCase().includes(t) || (c.phone && c.phone.includes(t))));
}

function clearCrmForm() {
    document.getElementById('crmHeader').innerText = "New Customer Profile";
    document.getElementById('crmId').value = "NEW"; 
    document.getElementById('crmName').value = "";
    document.getElementById('crmPhone').value = "";
    document.getElementById('crmIdNumber').value = "";
    document.getElementById('crmExpiration').value = "";
    document.getElementById('crmPlate').value = "";
    document.getElementById('crmTruck').value = "";
    document.getElementById('crmAddress').value = "";
    document.getElementById('crmEmail').value = "";
    document.getElementById('crmStats').innerText = "Lifetime: $0.00 (0 Tickets)";
    
    const preview = document.getElementById('dlPreview');
    preview.src = ""; 
    preview.alt = "Save profile first, then upload ID";
    
    const locationPreview = document.getElementById('locationImagePreview');
    locationPreview.src = "";
    locationPreview.alt = "Save profile first, then upload location image";
    
    document.getElementById('crmName').focus();
}

function selectCrmCustomer(id) {
    const c = crmCustomers.find(x => x.id === id);
    if(!c) return;
    document.getElementById('crmHeader').innerText = `Editing: ${c.name}`;
    document.getElementById('crmId').value = c.id;
    document.getElementById('crmName').value = c.name;
    document.getElementById('crmPhone').value = c.phone || '';
    document.getElementById('crmIdNumber').value = c.id_number || '';
    document.getElementById('crmExpiration').value = c.dl_expiration || '';
    document.getElementById('crmPlate').value = c.vehicle_plate || '';
    document.getElementById('crmTruck').value = c.truck_description || '';
    document.getElementById('crmAddress').value = c.address || '';
    document.getElementById('crmEmail').value = c.email || '';
    document.getElementById('crmIsVendor').checked = c.is_vendor || false;
    document.getElementById('crmDealerExemption').checked = c.dealer_exemption || false;
    document.getElementById('crmDealerNumber').value = c.dealer_number || '';
    
    document.getElementById('crmStats').innerText = `Lifetime: $${(c.lifetime_value||0).toFixed(2)} (${c.ticket_count} Tickets)`;
    
    const preview = document.getElementById('dlPreview');
    if (c.dl_picture) { preview.src = `file://${c.dl_picture}`; preview.alt = ""; }
    else { preview.src = ""; preview.alt = "Click to upload ID Picture"; }
    
    const locationPreview = document.getElementById('locationImagePreview');
    if (c.location_image) { locationPreview.src = `file://${c.location_image}`; locationPreview.alt = ""; }
    else { locationPreview.src = ""; locationPreview.alt = "Click to upload Location Image"; }
    
    toggleDealerNumberField();
}

function toggleDealerNumberField() {
    const dealerExemptCheckbox = document.getElementById('crmDealerExemption');
    const dealerNumberField = document.getElementById('dealerNumberFieldCRM');
    if (dealerExemptCheckbox && dealerNumberField) {
        dealerNumberField.style.display = dealerExemptCheckbox.checked ? 'block' : 'none';
    }
}

async function handleImageUpload(e) {
    const file = e.target.files[0];
    const cid = document.getElementById('crmId').value;
    
    if (cid === "NEW") return alert("Please click 'Save Profile' to create the customer before uploading their ID.");
    if (!file || !cid) return alert("Please select a customer first.");
    
    try {
        const result = await window.electronAPI.invoke('save-dl-image', { customerId: cid, sourcePath: file.path });
        document.getElementById('dlPreview').src = `file://${result.path}`;
        loadCrmCustomers(); 
    } catch(err) { 
        console.error('Error saving image:', err);
        alert("Error saving image."); 
    }
}

async function handleLocationImageUpload(e) {
    const file = e.target.files[0];
    const cid = document.getElementById('crmId').value;
    
    if (cid === "NEW") return alert("Please click 'Save Profile' to create the customer before uploading location image.");
    if (!file || !cid) return alert("Please select a customer first.");
    
    try {
        const result = await window.electronAPI.invoke('save-location-image', { customerId: cid, sourcePath: file.path });
        document.getElementById('locationImagePreview').src = `file://${result.path}`;
        alert("Location image saved successfully!");
        loadCrmCustomers(); 
    } catch(err) { 
        console.error('Error saving location image:', err);
        alert("Error saving location image."); 
    }
}

async function saveCrmCustomer() {
    const id = document.getElementById('crmId').value;
    const name = document.getElementById('crmName').value.trim();
    
    if(!id) return alert("Select a customer from the list or click 'Create New Customer'.");
    if(!name) return alert("Customer Name is required.");
    
    const data = {
        id: id, name: name,
        phone: document.getElementById('crmPhone').value,
        id_number: document.getElementById('crmIdNumber').value,
        dl_expiration: document.getElementById('crmExpiration').value,
        vehicle_plate: document.getElementById('crmPlate').value,
        truck_description: document.getElementById('crmTruck').value,
        address: document.getElementById('crmAddress').value,
        email: document.getElementById('crmEmail').value,
        is_vendor: document.getElementById('crmIsVendor').checked ? 1 : 0,
        dealer_exemption: document.getElementById('crmDealerExemption').checked ? 1 : 0,
        dealer_number: document.getElementById('crmDealerNumber').value
    };
    
    try {
        if (id === "NEW") {
            const result = await window.electronAPI.invoke('create-customer-profile', data);
            document.getElementById('crmId').value = result.newId; 
            document.getElementById('crmHeader').innerText = `Editing: ${data.name}`;
            alert("New Customer Created! You can now upload their ID picture.");
        } else {
            await window.electronAPI.invoke('save-customer-profile', data);
            alert("Profile Updated Successfully!");
        }
        loadCrmCustomers();
    } catch(e) { 
        console.error('Error saving profile:', e);
        alert("Error saving profile. Name might already exist."); 
    }
}

// --- 4. PRODUCT MGMT ---
async function loadProducts() {
    try {
        productsList = await window.electronAPI.invoke('get-products');
        const tbody = document.getElementById('productsTableBody');
        if (tbody) tbody.innerHTML = productsList.map(p => `<tr><td>${p.material_name}</td><td>$${p.price_per_lb.toFixed(2)}</td><td><button class="btn-action" onclick="editProduct(${p.id}, '${p.material_name}', ${p.price_per_lb})" style="margin-right:5px;">✏️</button><button class="btn-action" onclick="deleteProduct(${p.id})" style="color:red;">🗑️</button></td></tr>`).join('');
    } catch (error) {
        console.error('Error loading products:', error);
    }
}

async function addProduct() {
    const name = document.getElementById('newProdName').value.trim();
    const price = parseFloat(document.getElementById('newProdPrice').value);
    const id = document.getElementById('editingProductId').value;
    if (!name || isNaN(price)) return alert("Enter valid material name and price");

    try {
        if (id) {
            await window.electronAPI.invoke('update-product', { id: parseInt(id), name, price });
            alert("Material updated successfully!");
        } else {
            await window.electronAPI.invoke('add-product', { name, price });
            alert("Material added successfully!");
        }
        document.getElementById('newProdName').value = ''; 
        document.getElementById('newProdPrice').value = ''; 
        document.getElementById('editingProductId').value = "";
        loadProducts();
    } catch (err) {
        console.error('Error saving product:', err);
        alert("Error saving material: " + err.message);
    }
}

function editProduct(id, name, price) { 
    document.getElementById('newProdName').value = name; 
    document.getElementById('newProdPrice').value = price; 
    document.getElementById('editingProductId').value = id; 
    document.getElementById('newProdName').focus(); 
}

async function deleteProduct(id) { 
    try {
        if (confirm("Delete material? This cannot be undone.")) { 
            await window.electronAPI.invoke('delete-product', id); 
            loadProducts();
            alert("Material deleted successfully!");
        }
    } catch (error) {
        console.error('Error deleting product:', error);
        alert('Error deleting material');
    }
}

// --- 6. TICKET PRICE OVERRIDE & PDF PRINTING ---

let selectedTicketData = null;

async function viewTicketWithDetails(id) {
    try {
        const ticketData = await window.electronAPI.invoke('get-ticket-details-with-customer', id);
        selectedTicketData = ticketData;
        showTicketModal(ticketData);
    } catch (error) {
        console.error('Error viewing ticket:', error);
        alert('Error loading ticket details');
    }
}

function showTicketModal(data) {
    const { transaction, items, vehicle } = data;
    const modal = document.getElementById('ticketModal');

    let itemsHtml = items.map((item, idx) => `
        <tr>
            <td>${item.material_name}</td>
            <td>${item.net_weight} lbs</td>
            <td><input type="number" class="item-price-${item.id}" value="${item.total_price.toFixed(2)}" step="0.01"></td>
            <td><button class="btn-action" onclick="overrideItemPrice(${item.id}, ${item.ticket_id}, ${idx})">✎ Edit</button></td>
        </tr>
    `).join('');

    // Vehicle info section if present
    if (vehicle) {
        const titleStatus = vehicle.has_title ? '✅ Title' : '❌ No Title';
        const regStatus = vehicle.has_registration ? '✅ Registration' : '❌ No Registration';
        itemsHtml += `
        <tr><td colspan="4" style="padding:12px; background:#e8f4fd; border-left:4px solid #3498db;">
            <div style="font-weight:bold; margin-bottom:8px;">🚗 Vehicle Purchase</div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; font-size:13px;">
                <div><strong>VIN:</strong> ${vehicle.vin || 'N/A'}</div>
                <div><strong>Year:</strong> ${vehicle.year || 'N/A'}</div>
                <div><strong>Make:</strong> ${vehicle.make || 'N/A'}</div>
                <div><strong>Model:</strong> ${vehicle.model || 'N/A'}</div>
                <div><strong>Color:</strong> ${vehicle.color || 'N/A'}</div>
                <div><strong>Condition:</strong> ${vehicle.condition_notes || 'N/A'}</div>
            </div>
            ${vehicle.description ? `<div style="margin-top:6px; font-size:12px;"><strong>Notes:</strong> ${vehicle.description}</div>` : ''}
            <div style="margin-top:8px; font-size:12px; font-weight:bold;">${titleStatus} | ${regStatus}${vehicle.title_number ? ' (Title #' + vehicle.title_number + ')' : ''}</div>
        </td></tr>`;
    }
    
    const itemsContainer = document.getElementById('ticketItemsTable') || createTicketItemsTable();
    itemsContainer.innerHTML = itemsHtml;
    
    const totalInput = document.getElementById('ticketTotalOverride') || createTicketTotalInput();
    totalInput.value = transaction.total_amount.toFixed(2);
    totalInput.dataset.ticketId = transaction.id;
    totalInput.dataset.baseTotal = transaction.base_total || transaction.total_amount;
    
    modal.style.display = 'block';
}

function createTicketItemsTable() {
    const tableBody = document.getElementById('ticketItemsBody');
    if (!tableBody) {
        console.error('ticketItemsBody not found in ticket modal');
        return null;
    }
    return tableBody;
}

function createTicketTotalInput() {
    let input = document.getElementById('ticketTotalOverride');
    if (!input) {
        input = document.createElement('input');
        input.id = 'ticketTotalOverride';
        input.type = 'number';
        input.step = '0.01';
        document.getElementById('ticketModal')?.appendChild(input);
    }
    return input;
}

async function overrideItemPrice(itemId, ticketId, itemIndex) {
    const priceInput = document.querySelector(`.item-price-${itemId}`);
    const newPrice = parseFloat(priceInput.value);
    
    if (isNaN(newPrice) || newPrice < 0) {
        return alert('Please enter a valid price');
    }
    
    try {
        await window.electronAPI.invoke('update-ticket-item-price', {
            itemId,
            newPrice,
            isOverridden: true
        });
        
        // Recalculate ticket total
        let newTotal = 0;
        document.querySelectorAll('[class^="item-price-"]').forEach(input => {
            newTotal += parseFloat(input.value) || 0;
        });
        
        const totalInput = document.getElementById('ticketTotalOverride');
        totalInput.value = newTotal.toFixed(2);
        
        alert('Item price updated successfully!');
    } catch (error) {
        console.error('Error updating price:', error);
        alert('Error updating item price');
    }
}

async function overrideTicketTotal() {
    const totalInput = document.getElementById('ticketTotalOverride');
    const ticketId = totalInput.dataset.ticketId;
    const newTotal = parseFloat(totalInput.value);
    
    if (isNaN(newTotal) || newTotal < 0) {
        return alert('Please enter a valid total');
    }
    
    try {
        await window.electronAPI.invoke('update-ticket-price', {
            ticketId,
            newTotal,
            isOverridden: true
        });
        alert('Ticket total updated successfully!');
        loadTransactions();
    } catch (error) {
        console.error('Error updating ticket total:', error);
        alert('Error updating ticket total');
    }
}

function printTicketPDF() {
    if (!selectedTicketData) {
        return alert('No ticket selected');
    }

    const { transaction, items, vehicle } = selectedTicketData;
    
    // Create printable content
    const printContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px;">TICKET #${transaction.id}</h2>
        
        <div style="margin-top: 20px;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                <div>
                    <p><strong>Customer:</strong> ${transaction.name}</p>
                    <p><strong>Phone:</strong> ${transaction.phone || 'N/A'}</p>
                    <p><strong>ID:</strong> ${transaction.id_number || 'N/A'}</p>
                </div>
                <div>
                    <p><strong>Vehicle Plate:</strong> ${transaction.vehicle_plate || 'N/A'}</p>
                    <p><strong>Date:</strong> ${new Date(transaction.date).toLocaleString()}</p>
                    <p><strong>Address:</strong> ${transaction.address || 'N/A'}</p>
                </div>
            </div>
        </div>
        
        <table style="width: 100%; border-collapse: collapse; margin-top: 30px;">
            <thead>
                <tr style="border-bottom: 2px solid #333;">
                    <th style="text-align: left; padding: 10px;">Material</th>
                    <th style="text-align: center; padding: 10px;">Weight (lbs)</th>
                    <th style="text-align: right; padding: 10px;">Price</th>
                </tr>
            </thead>
            <tbody>
                ${items.map(item => `
                    <tr style="border-bottom: 1px solid #ddd;">
                        <td style="padding: 10px;">${item.material_name}</td>
                        <td style="text-align: center; padding: 10px;">${item.net_weight}</td>
                        <td style="text-align: right; padding: 10px;">$${item.total_price.toFixed(2)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
        
        <div style="margin-top: 20px; text-align: right; border-top: 2px solid #333; padding-top: 10px;">
            <h3 style="margin: 10px 0;">Total: $${transaction.total_amount.toFixed(2)}</h3>
            ${transaction.is_overridden ? '<p style="color: red; font-size: 12px;">⚠️ Price Override Applied</p>' : ''}
        </div>

        ${vehicle ? `
        <div style="margin-top: 20px; padding: 15px; border: 2px solid #3498db; border-radius: 8px; background: #f0f8ff;">
            <h3 style="margin: 0 0 10px 0; color: #2c3e50;">🚗 Vehicle Purchase Record</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <tr><td style="padding: 4px 8px; font-weight: bold; width: 120px;">VIN:</td><td style="padding: 4px 8px; font-family: monospace;">${vehicle.vin || 'N/A'}</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 4px 8px; font-weight: bold;">Year/Make/Model:</td><td style="padding: 4px 8px;">${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}</td></tr>
                <tr><td style="padding: 4px 8px; font-weight: bold;">Color:</td><td style="padding: 4px 8px;">${vehicle.color || 'N/A'}</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 4px 8px; font-weight: bold;">Condition:</td><td style="padding: 4px 8px;">${vehicle.condition_notes || 'N/A'}</td></tr>
                ${vehicle.description ? `<tr><td style="padding: 4px 8px; font-weight: bold;">Notes:</td><td style="padding: 4px 8px;">${vehicle.description}</td></tr>` : ''}
                <tr style="background: #f9f9f9;">
                    <td style="padding: 4px 8px; font-weight: bold;">Documentation:</td>
                    <td style="padding: 4px 8px;">
                        ${vehicle.has_title ? '✅ Title on file' : '❌ No title'}${vehicle.title_number ? ' (#' + vehicle.title_number + ')' : ''}
                        &nbsp;|&nbsp;
                        ${vehicle.has_registration ? '✅ Registration on file' : '❌ No registration'}
                    </td>
                </tr>
            </table>
        </div>
        ` : ''}

        <div style="margin-top: 40px; text-align: center; color: #666; font-size: 12px;">
            <p>Thank you for your business!</p>
            <p>Printed: ${new Date().toLocaleString()}</p>
        </div>
    </div>
    `;

    // Open print window
    const printWindow = window.open('', '', 'width=800,height=600');
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.print();
}

function closeTicketModal() {
    const modal = document.getElementById('ticketModal');
    if (modal) modal.style.display = 'none';
}
async function loadTransactions() { 
    try {
        const txs = await window.electronAPI.invoke('get-transactions'); 
        renderHistory(txs);
    } catch (error) {
        console.error('Error loading transactions:', error);
    }
}

function renderHistory(txs) {
    const tbody = document.getElementById('transactionTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = txs.map(t => {
        const displayDate = new Date(t.date).toLocaleDateString([], { 
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
        });
        const typeIcon = t.transaction_type === 'buy' ? '📦' : '💰';
        const typeLabel = t.transaction_type === 'buy' ? 'BUY' : 'SELL';
        return `<tr><td>${displayDate}</td><td>${t.customer_name}</td><td>${typeIcon} ${typeLabel}</td><td>$${t.total_amount.toFixed(2)}</td><td><button class="btn-action" onclick="viewTicketWithDetails(${t.id})">👁️ View</button><button class="btn-action" onclick="runCustomerReport(${t.customer_id})" style="margin-left:5px;">📊 Report</button></td></tr>`;
    }).join('');
}

async function filterHistory(term) { 
    try {
        if (!term.trim()) return loadTransactions(); 
        const results = await window.electronAPI.invoke('search-transactions', term); 
        renderHistory(results);
    } catch (error) {
        console.error('Error searching transactions:', error);
    }
}

async function showDatabaseStats() { 
    try {
        const s = await window.electronAPI.invoke('get-db-stats'); 
        let message = `📊 QUICK STATS\n\n`;
        message += `👥 Total Customers: ${s.customers || 0}\n`;
        message += `📋 Total Tickets: ${s.transactions || 0}\n`;
        message += `📦 Total Materials: ${s.products || 0}\n`;
        message += `💰 Total Paid Out: $${(s.totalRevenue || 0).toFixed(2)}\n`;
        message += `💵 Average Transaction: $${s.transactions > 0 ? (s.totalRevenue / s.transactions).toFixed(2) : '0.00'}`;
        alert(message);
    } catch (error) {
        console.error('Error getting database stats:', error);
        alert('Error loading database statistics');
    }
}

async function showSalesReport(p) { 
    try {
        const r = await window.electronAPI.invoke('get-sales-summary', p); 
        if (!r.length) return alert(`No sales data found for ${p} report`);
        
        let msg = `${p.toUpperCase()} SALES REPORT\n\n`, t = 0, totalCustomers = 0;
        r.forEach(d => { 
            msg += `${d.sale_date}: $${d.total_sales.toFixed(2)} (${d.transaction_count} tix, ${d.unique_customers} customers)\n`; 
            t += d.total_sales; 
            totalCustomers += d.unique_customers;
        }); 
        msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `TOTAL PAYOUT: $${t.toFixed(2)}\n`;
        msg += `UNIQUE CUSTOMERS: ${totalCustomers}\n`;
        msg += `AVG PER CUSTOMER: $${totalCustomers > 0 ? (t / totalCustomers).toFixed(2) : '0.00'}`;
        alert(msg);
    } catch (error) {
        console.error('Error generating sales report:', error);
        alert('Error generating sales report');
    }
}

async function showMaterialStats() { 
    try {
        const s = await window.electronAPI.invoke('get-material-stats', 'monthly'); 
        if (!s.length) return alert('No material data found.');
        
        let msg = `METALS (Last 30 Days)\n\n`;
        let totalWeight = 0, totalValue = 0;
        s.forEach(m => {
            msg += `${m.material_name}: ${m.total_weight.toFixed(0)} lbs | $${m.total_value.toFixed(2)} (${m.transaction_count} transactions)\n`;
            totalWeight += m.total_weight;
            totalValue += m.total_value;
        });
        msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `TOTAL WEIGHT: ${totalWeight.toFixed(0)} lbs\n`;
        msg += `TOTAL VALUE: $${totalValue.toFixed(2)}\n`;
        msg += `AVG PRICE: $${totalWeight > 0 ? (totalValue / totalWeight).toFixed(2) : '0.00'} per lb`;
        alert(msg);
    } catch (error) {
        console.error('Error generating material stats:', error);
        alert('Error generating material statistics');
    }
}

// Backup and Restore with File Dialogs
async function backupDatabaseWithDialog() {
    try {
        const result = await window.electronAPI.invoke('backup-database');
        if (result.success) {
            alert(`✅ Database backed up successfully!\n\nLocation: ${result.path}`);
        } else {
            alert(`Backup canceled: ${result.message}`);
        }
    } catch (error) {
        console.error('Error backing up database:', error);
        alert('Error creating database backup');
    }
}

async function restoreDatabaseWithDialog() {
    if (!confirm('⚠️ WARNING: This will replace your current database!\n\nMake sure you have a backup first.\n\nContinue?')) {
        return;
    }
    
    try {
        const result = await window.electronAPI.invoke('restore-database');
        if (result.success) {
            alert(`✅ Database restored!\n\n${result.message}`);
            // Reload or restart app
            location.reload();
        } else {
            alert(`Restore canceled: ${result.message}`);
        }
    } catch (error) {
        console.error('Error restoring database:', error);
        alert('Error restoring database');
    }
}

// Reports View Functions
function showReportsView() {
    showView('reports-view');
}

// Generate & Print from the Reports view filter controls
async function generateAndPrintReport() {
    const period = document.getElementById('reportPeriod').value;
    const reportType = document.getElementById('reportType').value;
    await generateReport(period, reportType);
}

// --- 9. DASHBOARD & ANALYTICS ---

async function loadDashboard() {
    try {
        const analytics = await window.electronAPI.invoke('get-dashboard-analytics');
        displayDashboard(analytics);
    } catch (error) {
        console.error('Error loading dashboard:', error);
        alert('Error loading dashboard analytics');
    }
}

function displayDashboard(analytics) {
    let html = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:20px; margin-bottom:20px;">
        <!-- Today's Sales -->
        <div style="background:linear-gradient(135deg, #27ae60, #2ecc71); color:white; padding:20px; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1);">
            <h3 style="margin:0 0 10px 0; font-size:14px; opacity:0.9;">TODAY'S SALES</h3>
            <p style="margin:0; font-size:28px; font-weight:bold;">$${(analytics.todaySales?.total || 0).toFixed(2)}</p>
            <p style="margin:5px 0 0 0; font-size:12px; opacity:0.8;">${analytics.todaySales?.count || 0} transactions</p>
        </div>
        
        <!-- Today's Purchases -->
        <div style="background:linear-gradient(135deg, #3498db, #5dade2); color:white; padding:20px; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1);">
            <h3 style="margin:0 0 10px 0; font-size:14px; opacity:0.9;">TODAY'S PURCHASES</h3>
            <p style="margin:0; font-size:28px; font-weight:bold;">$${(analytics.todayPurchases?.total || 0).toFixed(2)}</p>
            <p style="margin:5px 0 0 0; font-size:12px; opacity:0.8;">${analytics.todayPurchases?.count || 0} transactions</p>
        </div>
        
        <!-- Active Copper Holds -->
        <div style="background:linear-gradient(135deg, #e74c3c, #ec7063); color:white; padding:20px; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1);">
            <h3 style="margin:0 0 10px 0; font-size:14px; opacity:0.9;">⚠️ COPPER HOLDS</h3>
            <p style="margin:0; font-size:28px; font-weight:bold;">${analytics.activeCopperHolds?.count || 0}</p>
            <p style="margin:5px 0 0 0; font-size:12px; opacity:0.8;">${analytics.activeCopperHolds?.tickets || 0} active holds</p>
        </div>
        
        <!-- Pending Vouchers -->
        <div style="background:linear-gradient(135deg, #f39c12, #f8b88b); color:white; padding:20px; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1);">
            <h3 style="margin:0 0 10px 0; font-size:14px; opacity:0.9;">🎫 PENDING VOUCHERS</h3>
            <p style="margin:0; font-size:28px; font-weight:bold;">$${(analytics.pendingVouchers?.total_amount || 0).toFixed(2)}</p>
            <p style="margin:5px 0 0 0; font-size:12px; opacity:0.8;">${analytics.pendingVouchers?.count || 0} vouchers</p>
        </div>
    </div>
    
    <!-- Top Materials This Week -->
    <h3 style="margin-top:30px; border-bottom:2px solid #333; padding-bottom:10px;">Top Materials This Week</h3>
    <table style="width:100%; border-collapse:collapse;">
        <thead>
            <tr style="background:#f0f0f0;">
                <th style="padding:10px; text-align:left;">Material</th>
                <th style="padding:10px; text-align:right;">Weight (lbs)</th>
                <th style="padding:10px; text-align:right;">Value</th>
                <th style="padding:10px; text-align:right;">Profit</th>
            </tr>
        </thead>
        <tbody>
            ${(analytics.topMaterialsWeek || []).map(m => `
                <tr style="border-bottom:1px solid #ddd;">
                    <td style="padding:10px;">${m.material_name}</td>
                    <td style="padding:10px; text-align:right;">${m.total_weight.toFixed(0)}</td>
                    <td style="padding:10px; text-align:right;">$${m.total_value.toFixed(2)}</td>
                    <td style="padding:10px; text-align:right; color:#27ae60; font-weight:bold;">-</td>
                </tr>
            `).join('')}
        </tbody>
    </table>
    `;
    
    document.getElementById('dashboardContent').innerHTML = html;
}

// --- 10. INVENTORY MANAGEMENT ---

async function loadInventory() {
    try {
        const inventory = await window.electronAPI.invoke('get-inventory');
        displayInventory(inventory);
    } catch (error) {
        console.error('Error loading inventory:', error);
        alert('Error loading inventory');
    }
}

function displayInventory(items) {
    const html = `
    <table style="width:100%; border-collapse:collapse;">
        <thead>
            <tr style="background:#f0f0f0; border-bottom:2px solid #333;">
                <th style="padding:10px; text-align:left;">Material</th>
                <th style="padding:10px; text-align:right;">Quantity (lbs)</th>
                <th style="padding:10px; text-align:left;">Location</th>
                <th style="padding:10px; text-align:left;">Added</th>
                <th style="padding:10px; text-align:center;">Action</th>
            </tr>
        </thead>
        <tbody>
            ${items.map(item => `
                <tr style="border-bottom:1px solid #ddd;">
                    <td style="padding:10px; font-weight:bold;">${item.material_name}</td>
                    <td style="padding:10px; text-align:right;">${item.quantity_lbs.toFixed(2)}</td>
                    <td style="padding:10px;">${item.location || '-'}</td>
                    <td style="padding:10px; font-size:12px; color:#666;">${new Date(item.date_added).toLocaleDateString()}</td>
                    <td style="padding:10px; text-align:center;">
                        <button class="btn-action" onclick="removeInventory(${item.id})" style="color:red;">✕</button>
                    </td>
                </tr>
            `).join('')}
        </tbody>
    </table>
    ${items.length === 0 ? '<p style="text-align:center; color:#666;">No inventory items</p>' : ''}
    `;
    
    document.getElementById('inventoryTable').innerHTML = html;
}

function showAddInventoryForm() {
    const material = prompt('Material name (or ID):');
    if (!material) return;
    const qty = parseFloat(prompt('Quantity (lbs):'));
    if (isNaN(qty) || qty <= 0) return alert('Enter a valid quantity');
    const location = prompt('Storage location (optional):') || '';

    // Find product ID by name
    const product = productsList.find(p => p.material_name.toLowerCase() === material.toLowerCase() || String(p.id) === material);
    if (!product) return alert('Material not found. Add it in the Materials view first.');

    window.electronAPI.invoke('add-inventory', {
        materialId: product.id,
        quantityLbs: qty,
        location: location
    }).then(() => {
        alert('Inventory added!');
        loadInventory();
    }).catch(err => {
        console.error('Error adding inventory:', err);
        alert('Error adding inventory');
    });
}

async function removeInventory(id) {
    if (!confirm('Remove from inventory?')) return;

    try {
        await window.electronAPI.invoke('delete-inventory', id);
        alert('Inventory removed!');
        loadInventory();
    } catch (err) {
        console.error('Error removing inventory:', err);
        alert('Error removing inventory');
    }
}

// --- 11. PRICING & MARGINS ---

async function loadPricingAnalysis() {
    try {
        const products = await window.electronAPI.invoke('get-products');
        displayPricingAnalysis(products);
    } catch (error) {
        console.error('Error loading pricing:', error);
        alert('Error loading pricing data');
    }
}

function displayPricingAnalysis(products) {
    const html = `
    <table style="width:100%; border-collapse:collapse;">
        <thead>
            <tr style="background:#f0f0f0; border-bottom:2px solid #333;">
                <th style="padding:10px; text-align:left;">Material</th>
                <th style="padding:10px; text-align:right;">Cost/lb</th>
                <th style="padding:10px; text-align:right;">Sell Price/lb</th>
                <th style="padding:10px; text-align:right;">Margin</th>
                <th style="padding:10px; text-align:right;">Margin %</th>
                <th style="padding:10px; text-align:center;">Action</th>
            </tr>
        </thead>
        <tbody>
            ${products.map(p => {
                const costPerLb = p.cost_per_lb || 0;
                const sellPrice = p.price_per_lb || 0;
                const margin = sellPrice - costPerLb;
                const marginPercent = costPerLb > 0 ? ((margin / costPerLb) * 100) : 0;
                const marginColor = margin > 0 ? '#27ae60' : '#e74c3c';
                
                return `
                <tr style="border-bottom:1px solid #ddd;">
                    <td style="padding:10px; font-weight:bold;">${p.material_name}</td>
                    <td style="padding:10px; text-align:right;">$${costPerLb.toFixed(2)}</td>
                    <td style="padding:10px; text-align:right;">$${sellPrice.toFixed(2)}</td>
                    <td style="padding:10px; text-align:right; color:${marginColor}; font-weight:bold;">$${margin.toFixed(2)}</td>
                    <td style="padding:10px; text-align:right; color:${marginColor}; font-weight:bold;">${marginPercent.toFixed(1)}%</td>
                    <td style="padding:10px; text-align:center;">
                        <button class="btn-action" onclick="editPrice(${p.id}, '${p.material_name}', ${sellPrice}, ${costPerLb})">✎ Edit</button>
                    </td>
                </tr>
                `;
            }).join('')}
        </tbody>
    </table>
    `;
    
    document.getElementById('pricingTable').innerHTML = html;
}

// --- 12. CUSTOMER BALANCE TRACKING ---

async function loadCustomerBalances() {
    try {
        const balances = await window.electronAPI.invoke('get-all-customer-balances');
        displayCustomerBalances(balances);
    } catch (error) {
        console.error('Error loading balances:', error);
        alert('Error loading customer balances');
    }
}

function displayCustomerBalances(balances) {
    const tbody = document.getElementById('balancesTableBody');
    
    tbody.innerHTML = balances.map(b => {
        const balanceColor = b.balance > 0 ? '#27ae60' : b.balance < 0 ? '#e74c3c' : '#666';
        const statusText = b.balance > 0 ? '✓ Credit' : b.balance < 0 ? '⚠ Owing' : 'Even';
        const lastUpdated = new Date(b.last_updated).toLocaleDateString();
        
        return `
        <tr style="border-bottom:1px solid #ddd;">
            <td style="padding:10px; font-weight:bold;">${b.name}</td>
            <td style="padding:10px; text-align:center; color:${balanceColor}; font-weight:bold; font-size:16px;">$${b.balance.toFixed(2)}</td>
            <td style="padding:10px;">${statusText}</td>
            <td style="padding:10px; font-size:12px; color:#666;">${lastUpdated}</td>
        </tr>
        `;
    }).join('');
    
    if (balances.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="padding:20px; text-align:center; color:#666;">No customer balances recorded</td></tr>';
    }
}

// --- 13. COPPER HOLD MANAGEMENT UI ---

async function loadCopperHoldsUI() {
    try {
        const holds = await window.electronAPI.invoke('get-copper-holds');
        displayCopperHolds(holds);
    } catch (error) {
        console.error('Error loading copper holds:', error);
        alert('Error loading copper holds');
    }
}

function displayCopperHolds(holds) {
    const activeHolds = holds.filter(h => h.is_released === 0);
    
    const tbody = document.getElementById('copperHoldsTableBody');
    
    tbody.innerHTML = activeHolds.map(h => {
        const holdExpiry = new Date(h.hold_expiry);
        const now = new Date();
        const daysLeft = Math.ceil((holdExpiry - now) / (1000 * 60 * 60 * 24));
        
        const expiryColor = daysLeft <= 1 ? '#e74c3c' : daysLeft <= 2 ? '#f39c12' : '#27ae60';
        const holdStartDate = new Date(h.hold_start).toLocaleDateString();
        const expiryDate = holdExpiry.toLocaleDateString();
        
        return `
        <tr style="border-bottom:1px solid #ddd;">
            <td style="padding:10px; font-weight:bold;">${h.name}</td>
            <td style="padding:10px; text-align:center;">#${h.transaction_id}</td>
            <td style="padding:10px; text-align:right;">-</td>
            <td style="padding:10px; text-align:center; font-size:12px;">${holdStartDate}</td>
            <td style="padding:10px; text-align:center; font-size:12px; color:${expiryColor}; font-weight:bold;">${expiryDate}</td>
            <td style="padding:10px; text-align:center; color:${expiryColor}; font-weight:bold;">${daysLeft}</td>
            <td style="padding:10px; text-align:center;">
                ${daysLeft <= 0 ? `<button class="btn-action" onclick="releaseCopperHold(${h.id})" style="background:#27ae60; color:white;">Release</button>` : '<span style="color:#999;">—</span>'}
            </td>
        </tr>
        `;
    }).join('');
    
    if (activeHolds.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:20px; text-align:center; color:#666;">No active copper holds</td></tr>';
    }
}

async function releaseCopperHold(holdId) {
    if (!confirm('Release this copper hold? (5-day period must have elapsed)')) {
        return;
    }
    
    try {
        await window.electronAPI.invoke('release-copper-hold', holdId);
        alert('✅ Copper hold released');
        loadCopperHoldsUI();
    } catch (error) {
        console.error('Error releasing hold:', error);
        alert('Error releasing copper hold');
    }
}

// --- 14. PRICING MANAGEMENT ---

async function loadProductsForPricing() {
    try {
        const products = await window.electronAPI.invoke('get-products');
        const select = document.getElementById('priceUpdateMaterial');
        select.innerHTML = '<option value="">-- Select Material --</option>' + 
            products.map(p => `<option value="${p.id}" data-price="${p.price_per_lb}">${p.material_name} ($${p.price_per_lb.toFixed(2)}/lb)</option>`).join('');
    } catch (error) {
        console.error('Error loading products:', error);
    }
}

async function updateMaterialPrice() {
    const materialSelect = document.getElementById('priceUpdateMaterial');
    const newPriceInput = document.getElementById('priceUpdatePrice');
    
    if (!materialSelect.value) {
        return alert('Please select a material');
    }
    
    const newPrice = parseFloat(newPriceInput.value);
    if (isNaN(newPrice) || newPrice < 0) {
        return alert('Please enter a valid price');
    }
    
    const oldPrice = parseFloat(materialSelect.options[materialSelect.selectedIndex].getAttribute('data-price'));
    const productId = parseInt(materialSelect.value);
    
    try {
        await window.electronAPI.invoke('update-product-price', { 
            productId, 
            newPrice, 
            oldPrice 
        });
        
        alert(`✅ Price updated!\n${materialSelect.options[materialSelect.selectedIndex].text}\n$${oldPrice.toFixed(2)} → $${newPrice.toFixed(2)}`);
        
        // Reset form
        materialSelect.value = '';
        newPriceInput.value = '';
        
        loadPricingAnalysis();
    } catch (error) {
        console.error('Error updating price:', error);
        alert('Error updating price');
    }
}

async function viewTicket(id) {
    await viewTicketWithDetails(id);
}

// Edit price from Pricing & Margins table
function editPrice(productId, materialName, sellPrice, costPerLb) {
    const select = document.getElementById('priceUpdateMaterial');
    const priceInput = document.getElementById('priceUpdatePrice');

    // Select the matching material in the dropdown
    for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value == productId) {
            select.selectedIndex = i;
            break;
        }
    }

    priceInput.value = sellPrice.toFixed(2);
    priceInput.focus();
}

async function runCustomerReport(id) { 
    try {
        const r = await window.electronAPI.invoke('get-customer-report', id); 
        if (!r.length) return alert("No history found for this customer");
        
        let t = 0; 
        const details = r.map(x => { 
            t += x.total_price; 
            return `${new Date(x.date).toLocaleDateString()}: ${x.material_name} - ${x.net_weight} lbs - $${x.total_price.toFixed(2)}`; 
        }).join('\n'); 
        alert(`CUSTOMER LIFETIME REPORT\n\n${details}\n\nTotal: $${t.toFixed(2)}`);
    } catch (error) {
        console.error('Error generating customer report:', error);
        alert('Error generating customer report');
    }
}

async function exportCustomers() {
    try {
        const c = await window.electronAPI.invoke('export-customers'); 
        if (!c.length) return alert('No customers found to export');
        
        let csv = "Name,Phone,ID,Vehicle,Truck,Address,Email\n";
        c.forEach(x => csv += `"${x.name}","${x.phone||''}","${x.id_number||''}","${x.vehicle_plate||''}","${x.truck_description||''}","${x.address||''}","${x.email||''}"\n`);
        const a = document.createElement('a'); 
        a.href = window.URL.createObjectURL(new Blob([csv], {type: 'text/csv'})); 
        a.download = 'customers.csv'; 
        a.click();
        alert('✅ Customer list exported successfully!');
    } catch (error) {
        console.error('Error exporting customers:', error);
        alert('Error exporting customers');
    }
}

// --- 15. VEHICLE PURCHASE DATABASE ---

let allVehiclePurchases = [];

async function loadVehicleDatabase() {
    try {
        allVehiclePurchases = await window.electronAPI.invoke('get-all-vehicle-purchases');
        renderVehicleDatabase(allVehiclePurchases);
    } catch (error) {
        console.error('Error loading vehicle database:', error);
        alert('Error loading vehicle database');
    }
}

function filterVehicleDatabase(term) {
    const docFilter = document.getElementById('vehicleDocFilter').value;
    let filtered = allVehiclePurchases;

    if (term && term.trim()) {
        const t = term.toLowerCase();
        filtered = filtered.filter(v =>
            (v.vin && v.vin.toLowerCase().includes(t)) ||
            (v.make && v.make.toLowerCase().includes(t)) ||
            (v.model && v.model.toLowerCase().includes(t)) ||
            (v.year && v.year.includes(t)) ||
            (v.color && v.color.toLowerCase().includes(t)) ||
            (v.customer_name && v.customer_name.toLowerCase().includes(t)) ||
            (v.description && v.description.toLowerCase().includes(t))
        );
    }

    if (docFilter === 'has-title') filtered = filtered.filter(v => v.has_title);
    else if (docFilter === 'no-title') filtered = filtered.filter(v => !v.has_title);
    else if (docFilter === 'has-reg') filtered = filtered.filter(v => v.has_registration);
    else if (docFilter === 'no-docs') filtered = filtered.filter(v => !v.has_title && !v.has_registration);

    renderVehicleDatabase(filtered);
}

function renderVehicleDatabase(vehicles) {
    // Summary bar
    const totalVehicles = vehicles.length;
    const withTitle = vehicles.filter(v => v.has_title).length;
    const withReg = vehicles.filter(v => v.has_registration).length;
    const noDocs = vehicles.filter(v => !v.has_title && !v.has_registration).length;
    const totalValue = vehicles.reduce((sum, v) => sum + (v.total_amount || 0), 0);

    document.getElementById('vehicleSummaryBar').innerHTML = `
        <span>📊 Total: ${totalVehicles}</span>
        <span>💰 Value: $${totalValue.toFixed(2)}</span>
        <span style="color:#27ae60;">✅ Titled: ${withTitle}</span>
        <span style="color:#3498db;">📋 Registered: ${withReg}</span>
        <span style="color:#e74c3c;">⚠️ No Docs: ${noDocs}</span>
    `;

    const html = `
    <table style="width:100%; border-collapse:collapse;">
        <thead>
            <tr style="background:#f0f0f0; border-bottom:2px solid #333;">
                <th style="padding:10px; text-align:left;">Date</th>
                <th style="padding:10px; text-align:left;">VIN</th>
                <th style="padding:10px; text-align:left;">Year/Make/Model</th>
                <th style="padding:10px; text-align:left;">Color</th>
                <th style="padding:10px; text-align:left;">Condition</th>
                <th style="padding:10px; text-align:left;">Seller</th>
                <th style="padding:10px; text-align:right;">Price</th>
                <th style="padding:10px; text-align:center;">Docs</th>
                <th style="padding:10px; text-align:center;">Actions</th>
            </tr>
        </thead>
        <tbody>
            ${vehicles.map(v => {
                const dateStr = v.date ? new Date(v.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }) : '';
                const ymm = [v.year, v.make, v.model].filter(Boolean).join(' ') || 'N/A';
                const titleBadge = v.has_title
                    ? '<span style="background:#d4edda; color:#155724; padding:2px 6px; border-radius:3px; font-size:10px; font-weight:bold;">TITLE</span>'
                    : '';
                const regBadge = v.has_registration
                    ? '<span style="background:#cce5ff; color:#004085; padding:2px 6px; border-radius:3px; font-size:10px; font-weight:bold;">REG</span>'
                    : '';
                const noDocs = !v.has_title && !v.has_registration
                    ? '<span style="background:#f8d7da; color:#721c24; padding:2px 6px; border-radius:3px; font-size:10px; font-weight:bold;">NO DOCS</span>'
                    : '';
                const condColor = (v.condition_notes || '').includes('Running') ? '#27ae60' : '#e67e22';

                return `
                <tr style="border-bottom:1px solid #eee;" onmouseover="this.style.background='#f9f9f9'" onmouseout="this.style.background='transparent'">
                    <td style="padding:10px; font-size:12px; color:#666;">${dateStr}</td>
                    <td style="padding:10px; font-family:monospace; font-size:12px;">${v.vin || 'N/A'}</td>
                    <td style="padding:10px; font-weight:bold;">${ymm}</td>
                    <td style="padding:10px;">${v.color || '-'}</td>
                    <td style="padding:10px; font-size:12px; color:${condColor};">${v.condition_notes || '-'}</td>
                    <td style="padding:10px; font-size:12px;">${v.customer_name || '-'}</td>
                    <td style="padding:10px; text-align:right; font-weight:bold; color:#27ae60;">$${(v.total_amount || 0).toFixed(2)}</td>
                    <td style="padding:10px; text-align:center;">${titleBadge} ${regBadge} ${noDocs}</td>
                    <td style="padding:10px; text-align:center;">
                        <button class="btn-action" onclick="editVehicleRecord(${v.id})" style="margin-right:3px;">✏️ Edit</button>
                        <button class="btn-action" onclick="printVehicleRecord(${v.id})">🖨️</button>
                    </td>
                </tr>`;
            }).join('')}
        </tbody>
    </table>
    ${vehicles.length === 0 ? '<p style="text-align:center; color:#666; padding:30px;">No vehicle purchases recorded yet.</p>' : ''}
    `;

    document.getElementById('vehicleDatabaseTable').innerHTML = html;
}

function editVehicleRecord(vehicleId) {
    const v = allVehiclePurchases.find(x => x.id === vehicleId);
    if (!v) return alert('Vehicle record not found');

    document.getElementById('vehEditId').value = v.id;
    document.getElementById('vehEditTicketId').value = v.ticket_id;
    document.getElementById('vehEditVin').value = v.vin || '';
    document.getElementById('vehEditYear').value = v.year || '';
    document.getElementById('vehEditMake').value = v.make || '';
    document.getElementById('vehEditModel').value = v.model || '';
    document.getElementById('vehEditColor').value = v.color || '';
    document.getElementById('vehEditCondition').value = v.condition_notes || '';
    document.getElementById('vehEditDescription').value = v.description || '';
    document.getElementById('vehEditPrice').value = (v.total_amount || 0).toFixed(2);
    document.getElementById('vehEditHasTitle').checked = !!v.has_title;
    document.getElementById('vehEditHasReg').checked = !!v.has_registration;
    document.getElementById('vehEditTitleNumber').value = v.title_number || '';
    document.getElementById('vehEditTitleNumWrap').style.display = v.has_title ? 'inline-block' : 'none';

    const dateStr = v.date ? new Date(v.date).toLocaleString() : 'Unknown';
    document.getElementById('vehEditInfo').innerHTML =
        `<strong>Ticket #${v.ticket_id}</strong> | Purchased from: <strong>${v.customer_name || 'Unknown'}</strong> | Date: ${dateStr}` +
        (v.phone ? ` | Phone: ${v.phone}` : '');

    document.getElementById('vehicleEditModal').style.display = 'block';
}

async function saveVehicleEdit() {
    const data = {
        id: parseInt(document.getElementById('vehEditId').value),
        vin: (document.getElementById('vehEditVin').value || '').trim().toUpperCase(),
        year: document.getElementById('vehEditYear').value.trim(),
        make: document.getElementById('vehEditMake').value.trim(),
        model: document.getElementById('vehEditModel').value.trim(),
        color: document.getElementById('vehEditColor').value.trim(),
        conditionNotes: document.getElementById('vehEditCondition').value,
        description: document.getElementById('vehEditDescription').value.trim(),
        hasTitle: document.getElementById('vehEditHasTitle').checked,
        hasRegistration: document.getElementById('vehEditHasReg').checked,
        titleNumber: document.getElementById('vehEditTitleNumber').value.trim()
    };

    try {
        await window.electronAPI.invoke('update-vehicle-purchase', data);
        alert('Vehicle record updated!');
        document.getElementById('vehicleEditModal').style.display = 'none';
        loadVehicleDatabase();
    } catch (err) {
        console.error('Error saving vehicle:', err);
        alert('Error saving vehicle record');
    }
}

async function saveVehiclePrice() {
    const ticketId = document.getElementById('vehEditTicketId').value;
    const newPrice = parseFloat(document.getElementById('vehEditPrice').value);

    if (isNaN(newPrice) || newPrice < 0) return alert('Enter a valid price');

    try {
        await window.electronAPI.invoke('update-ticket-price', {
            ticketId: ticketId,
            newTotal: newPrice,
            isOverridden: true
        });
        // Also save the vehicle field edits
        await saveVehicleEdit();
    } catch (err) {
        console.error('Error updating vehicle price:', err);
        alert('Error updating price');
    }
}

function printVehicleRecord(vehicleId) {
    const v = allVehiclePurchases.find(x => x.id === vehicleId);
    if (!v) return;

    const ymm = [v.year, v.make, v.model].filter(Boolean).join(' ');
    const dateStr = v.date ? new Date(v.date).toLocaleString() : '';

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 30px;">
        <h1 style="text-align: center; margin: 0; border-bottom: 3px solid #333; padding-bottom: 15px;">VEHICLE PURCHASE RECORD</h1>
        <p style="text-align: center; color: #666; margin-top: 8px;">Ticket #${v.ticket_id} | ${dateStr}</p>

        <table style="width: 100%; border-collapse: collapse; margin-top: 25px; font-size: 14px;">
            <tr style="background: #f9f9f9;"><td style="padding: 10px; font-weight: bold; width: 150px; border: 1px solid #ddd;">VIN</td><td style="padding: 10px; font-family: monospace; border: 1px solid #ddd;">${v.vin || 'N/A'}</td></tr>
            <tr><td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Year / Make / Model</td><td style="padding: 10px; border: 1px solid #ddd;">${ymm || 'N/A'}</td></tr>
            <tr style="background: #f9f9f9;"><td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Color</td><td style="padding: 10px; border: 1px solid #ddd;">${v.color || 'N/A'}</td></tr>
            <tr><td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Condition</td><td style="padding: 10px; border: 1px solid #ddd;">${v.condition_notes || 'N/A'}</td></tr>
            <tr style="background: #f9f9f9;"><td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Description</td><td style="padding: 10px; border: 1px solid #ddd;">${v.description || 'N/A'}</td></tr>
            <tr><td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Seller</td><td style="padding: 10px; border: 1px solid #ddd;">${v.customer_name || 'N/A'}${v.phone ? ' (' + v.phone + ')' : ''}</td></tr>
            <tr style="background: #f9f9f9;"><td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Purchase Price</td><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; font-size: 16px; color: #27ae60;">$${(v.total_amount || 0).toFixed(2)}</td></tr>
            <tr><td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Title</td><td style="padding: 10px; border: 1px solid #ddd;">${v.has_title ? '✅ On file' + (v.title_number ? ' (#' + v.title_number + ')' : '') : '❌ Not available'}</td></tr>
            <tr style="background: #f9f9f9;"><td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Registration</td><td style="padding: 10px; border: 1px solid #ddd;">${v.has_registration ? '✅ On file' : '❌ Not available'}</td></tr>
        </table>

        <div style="margin-top: 30px; text-align: center; color: #666; font-size: 12px;">
            <p>Printed: ${new Date().toLocaleString()}</p>
        </div>
    </div>
    `;

    const printWindow = window.open('', '', 'width=800,height=700');
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.print();
}

// ===== SCALE INTEGRATION =====

// Listen for scale weight updates
window.electronAPI.onScaleWeight((weight) => {
    lastScaleWeight = weight;
    const display = document.getElementById('liveWeight');
    if (display) {
        display.textContent = weight.toFixed(2);
        display.style.color = '#fff';
        display.style.textShadow = '0 0 10px rgba(0,0,0,0.3)';
        
        // Reset text shadow after 200ms
        setTimeout(() => {
            display.style.textShadow = 'none';
        }, 200);
    }
    addDebugMessage(`✅ ${weight.toFixed(2)} lbs`, 'success');
});

// Scale status is handled by scale-settings.js if loaded;
// this is a lightweight fallback for the main renderer.
window.electronAPI.onScaleStatus((status) => {
    // Status updates handled by scale-settings.js UI when present
});

// Make live weight display clickable to apply to focused field
document.addEventListener('DOMContentLoaded', function() {
    const liveWeightDisplay = document.getElementById('liveWeight');
    if (liveWeightDisplay) {
        liveWeightDisplay.style.cursor = 'pointer';
        liveWeightDisplay.title = 'Click to apply scale weight to focused field';
        liveWeightDisplay.addEventListener('click', function() {
            if (!currentFocusedRowId) {
                showToast('⚠️ Click on a weight field first', true);
                return;
            }
            
            if (lastScaleWeight <= 0) {
                showToast('⚠️ No weight from scale yet', true);
                return;
            }
            
            // Find the focused row and apply to it
            const row = document.getElementById(`row-${currentFocusedRowId}`);
            if (!row) return;
            
            const grossField = row.querySelector('.gross');
            const tareField = row.querySelector('.tare');
            
            // Determine which field is more recently focused
            if (grossField) {
                grossField.value = lastScaleWeight.toFixed(2);
                calculateRow(currentFocusedRowId);
                showToast(`✅ Applied ${lastScaleWeight.toFixed(2)} lbs to gross weight`);
            }
        });
    }
});

// Boot on load
setTimeout(() => {
    loadProducts().catch(err => console.error('Products error:', err));
    loadTransactions().catch(err => console.error('Transactions error:', err));
    loadCrmCustomers().catch(err => console.error('CRM error:', err));
}, 50);

// Initialize UI immediately (no await)
const ticketView = document.getElementById('ticket-view');
if (ticketView) {
    const alertBanner = document.getElementById('dlAlertBanner');
    if (alertBanner) alertBanner.style.display = 'none';
    const body = document.getElementById('splitWeighingBody');
    if (body) {
        body.innerHTML = '';
        addSplitRow(false);
    }
    const custName = document.getElementById('custName');
    if (custName) custName.focus();
}
