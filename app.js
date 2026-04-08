// --- CONFIGURATION ---
// UUID for standard HM-10 / ESP32 BLE UART
const BLE_SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const BLE_CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";

let bleDevice = null;
let bleCharacteristic = null;
let isConnected = false;

// Robot State
const state = {
    throttle: 0, // Y axis from left joystick (-1 to 1)
    steering: 0, // X axis from right joystick (-1 to 1)
    maxSpeed: 255,
    mode: "analog",
    isBoost: false,
    isEStop: false
};

// --- DOM ELEMENTS ---
const logEl = document.getElementById('log-output');
const speedSlider = document.getElementById('slider-speed');
const speedVal = document.getElementById('speed-val');
const modeSelect = document.getElementById('select-mode');
const btnConnect = document.getElementById('btn-connect');
const btnBoost = document.getElementById('btn-boost');
const btnEstop = document.getElementById('btn-estop');
const statusDot = document.getElementById('bt-status-dot');
const statusText = document.getElementById('bt-status-text');

// --- UTILS ---
function log(msg) {
    logEl.innerHTML = `> ${msg}<br>` + logEl.innerHTML;
    if(logEl.innerHTML.length > 500) logEl.innerHTML = logEl.innerHTML.substring(0, 500);
}

function updateStatus(connected) {
    isConnected = connected;
    statusDot.className = `dot ${connected ? 'connected' : 'disconnected'}`;
    statusText.innerText = connected ? 'Connected' : 'Disconnected';
    btnConnect.innerText = connected ? 'Disconnect' : 'Connect BLE';
}

function vibrate() {
    if (navigator.vibrate) navigator.vibrate(50);
}

// --- VIRTUAL JOYSTICK LOGIC ---
class VirtualJoystick {
    constructor(containerId, knobId, axis, onMove) {
        this.container = document.getElementById(containerId);
        this.knob = document.getElementById(knobId);
        this.axis = axis; // 'Y' for throttle, 'X' for steering
        this.onMove = onMove;
        this.active = false;
        this.maxRadius = this.container.offsetWidth / 2 - this.knob.offsetWidth / 2;

        this.container.addEventListener('touchstart', this.handleStart.bind(this), {passive: false});
        this.container.addEventListener('touchmove', this.handleMove.bind(this), {passive: false});
        window.addEventListener('touchend', this.handleEnd.bind(this));
        
        // Mouse support for desktop testing
        this.container.addEventListener('mousedown', this.handleStart.bind(this));
        window.addEventListener('mousemove', this.handleMove.bind(this));
        window.addEventListener('mouseup', this.handleEnd.bind(this));
    }

    handleStart(e) {
        e.preventDefault();
        this.active = true;
        this.updatePosition(e);
    }

    handleMove(e) {
        if (!this.active) return;
        e.preventDefault();
        this.updatePosition(e);
    }

    handleEnd(e) {
        if (!this.active) return;
        this.active = false;
        this.knob.style.transform = `translate(-50%, -50%)`;
        this.onMove(0);
    }

    updatePosition(e) {
        const rect = this.container.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        let x = clientX - rect.left - rect.width / 2;
        let y = clientY - rect.top - rect.height / 2;

        // Constrain to axis
        if (this.axis === 'Y') x = 0;
        if (this.axis === 'X') y = 0;

        // Calculate distance and clamp
        const distance = Math.min(Math.sqrt(x*x + y*y), this.maxRadius);
        const angle = Math.atan2(y, x);

        const finalX = this.axis === 'X' ? distance * Math.cos(angle) : 0;
        const finalY = this.axis === 'Y' ? distance * Math.sin(angle) : 0;

        this.knob.style.transform = `translate(calc(-50% + ${finalX}px), calc(-50% + ${finalY}px))`;

        // Normalize value from -1.0 to 1.0
        // For Y (Throttle): Up is negative Y in DOM, so we invert it for robotics (Up = +1)
        let normalizedValue = 0;
        if (this.axis === 'Y') normalizedValue = -(finalY / this.maxRadius);
        if (this.axis === 'X') normalizedValue = (finalX / this.maxRadius);

        // Deadzone filter
        if (Math.abs(normalizedValue) < 0.15) normalizedValue = 0;

        this.onMove(normalizedValue);
    }
}

// Initialize Joysticks
const leftJoy = new VirtualJoystick('joystick-left', 'knob-left', 'Y', (val) => {
    state.throttle = val;
    processAndSend();
});

const rightJoy = new VirtualJoystick('joystick-right', 'knob-right', 'X', (val) => {
    state.steering = val;
    processAndSend();
});

// --- UI LISTENERS ---
speedSlider.addEventListener('input', (e) => {
    state.maxSpeed = parseInt(e.target.value);
    speedVal.innerText = state.maxSpeed;
    localStorage.setItem('mj_speed', state.maxSpeed);
});

modeSelect.addEventListener('change', (e) => {
    state.mode = e.target.value;
    localStorage.setItem('mj_mode', state.mode);
});

btnBoost.addEventListener('mousedown', () => { state.isBoost = true; vibrate(); processAndSend(); });
btnBoost.addEventListener('mouseup', () => { state.isBoost = false; processAndSend(); });
btnBoost.addEventListener('touchstart', (e) => { e.preventDefault(); state.isBoost = true; vibrate(); processAndSend(); });
btnBoost.addEventListener('touchend', () => { state.isBoost = false; processAndSend(); });

btnEstop.addEventListener('click', () => {
    state.isEStop = !state.isEStop;
    btnEstop.style.background = state.isEStop ? "#555" : "var(--accent-red)";
    vibrate();
    processAndSend();
});

// Load Settings
if(localStorage.getItem('mj_speed')) {
    state.maxSpeed = localStorage.getItem('mj_speed');
    speedSlider.value = state.maxSpeed;
    speedVal.innerText = state.maxSpeed;
}
if(localStorage.getItem('mj_mode')) {
    state.mode = localStorage.getItem('mj_mode');
    modeSelect.value = state.mode;
}

// --- ROBOT KINEMATICS & DATA SENDING ---
let lastSendTime = 0;
const SEND_INTERVAL = 50; // ms (20Hz update rate)

function processAndSend() {
    if (state.isEStop) {
        sendData({ leftMotor: 0, rightMotor: 0, mode: "estop" });
        return;
    }

    // Arcade Drive to Tank Drive mapping
    let left = state.throttle + state.steering;
    let right = state.throttle - state.steering;

    // Normalize mapping (prevent exceeding 1.0)
    const maxVal = Math.max(Math.abs(left), Math.abs(right));
    if (maxVal > 1.0) {
        left /= maxVal;
        right /= maxVal;
    }

    // Apply speed multiplier & boost
    let currentMaxSpeed = state.isBoost ? 255 : state.maxSpeed;
    
    let leftMotor = Math.round(left * currentMaxSpeed);
    let rightMotor = Math.round(right * currentMaxSpeed);

    // Digital mode logic (Round to max or 0)
    if (state.mode === "digital") {
        leftMotor = leftMotor > 50 ? currentMaxSpeed : (leftMotor < -50 ? -currentMaxSpeed : 0);
        rightMotor = rightMotor > 50 ? currentMaxSpeed : (rightMotor < -50 ? -currentMaxSpeed : 0);
    }

    const payload = {
        leftMotor: leftMotor,
        rightMotor: rightMotor,
        mode: state.mode
    };

    // Throttle data sending to prevent overwhelming Bluetooth buffer
    const now = Date.now();
    if (now - lastSendTime >= SEND_INTERVAL) {
        sendData(payload);
        lastSendTime = now;
    }
}

// --- BLUETOOTH WEBSOCKET/FALLBACK ---
async function toggleBluetooth() {
    if (isConnected) {
        if (bleDevice && bleDevice.gatt.connected) {
            bleDevice.gatt.disconnect();
        }
        return;
    }

    try {
        log("Requesting BLE Device...");
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ services: [BLE_SERVICE_UUID] }],
            optionalServices: [BLE_SERVICE_UUID]
        });

        bleDevice.addEventListener('gattserverdisconnected', () => {
            updateStatus(false);
            log("BLE Disconnected");
            vibrate();
        });

        log("Connecting to GATT Server...");
        const server = await bleDevice.gatt.connect();
        
        log("Getting Service...");
        const service = await server.getPrimaryService(BLE_SERVICE_UUID);
        
        log("Getting Characteristic...");
        bleCharacteristic = await service.getCharacteristic(BLE_CHARACTERISTIC_UUID);

        updateStatus(true);
        log("Ready to Control!");
        vibrate();

    } catch (error) {
        log("BLE Error: " + error);
        updateStatus(false);
    }
}

btnConnect.addEventListener('click', toggleBluetooth);

async function sendData(jsonData) {
    const jsonString = JSON.stringify(jsonData) + "\n"; // Newline for parser termination
    
    if (isConnected && bleCharacteristic) {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(jsonString);
            // If using HM-10/ESP32, writeValueWithoutResponse is preferred for real-time
            if(bleCharacteristic.properties.writeWithoutResponse) {
                await bleCharacteristic.writeValueWithoutResponse(data);
            } else {
                await bleCharacteristic.writeValue(data);
            }
        } catch (err) {
            console.error(err);
        }
    } else {
        // Fallback or Debug log
        console.log("Mock Send:", jsonString);
    }
}
