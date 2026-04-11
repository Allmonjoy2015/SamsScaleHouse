let currentLiveWeight = 0;

// 1. Listen for live data from the scale
window.electronAPI.onScaleUpdate((weight) => {
    currentLiveWeight = parseFloat(weight);
    document.getElementById('liveWeight').innerText = currentLiveWeight.toFixed(1);
});

// 2. Lock current weight into a specific axle field
function capture(fieldId) {
    const field = document.getElementById(fieldId);
    if (!field) return;
    field.value = currentLiveWeight.toFixed(1);

    // Flash the field green briefly to confirm lock
    field.style.transition = 'background 0.1s';
    field.style.background = '#1a3a1a';
    setTimeout(() => { field.style.background = ''; }, 400);
}

// 3. Split Weight Calculator — sums all three axle fields into Net Weight
function runSplitCalculator() {
    const f = parseFloat(document.getElementById('front').value)   || 0;
    const r = parseFloat(document.getElementById('rear').value)    || 0;
    const t = parseFloat(document.getElementById('trailer').value) || 0;

    const sum = f + r + t;
    document.getElementById('netWeight').value = sum.toFixed(1);
}

// 4. Save and Print
document.getElementById('saveBtn').addEventListener('click', async () => {
    const data = {
        customer_id:   document.getElementById('custId').value.trim(),
        front_axle:    parseFloat(document.getElementById('front').value)     || 0,
        rear_axle:     parseFloat(document.getElementById('rear').value)      || 0,
        trailer:       parseFloat(document.getElementById('trailer').value)   || 0,
        total_weight:  parseFloat(document.getElementById('netWeight').value) || 0,
        payout:        parseFloat(document.getElementById('payout').value)    || 0
    };

    if (!data.customer_id) {
        alert('Please enter a Truck / Customer ID.');
        return;
    }
    if (data.total_weight === 0) {
        alert('Weight is zero — lock axle readings and press the calculator button first.');
        return;
    }

    try {
        await window.electronAPI.invoke('add-split-ticket', {
            customer_name:    data.customer_id,
            id_number:        data.customer_id,
            vehicle_plate:    '',
            total_amount:     data.payout,
            transaction_type: 'buy',
            materials: [{
                material: 'Split Weigh',
                net:      data.total_weight,
                total:    data.payout
            }]
        });

        // Reset form on success
        ['custId', 'front', 'rear', 'trailer', 'netWeight', 'payout'].forEach(id => {
            document.getElementById(id).value = '';
        });

        alert('Ticket saved successfully!');
    } catch (err) {
        console.error('Save error:', err);
        alert('Error saving ticket: ' + err.message);
    }
});
