const net = require('net');
const express = require('express');
const LifxClient = require('node-lifx').Client;

console.log('Loading iPortSMButtonsLAN plugin (LIFX edition with heartbeat)');

class IPortSMButtonsPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    // network/config
    this.ip = this.config.ip || '192.168.2.12';
    this.port = this.config.port || 10001;
    this.timeout = this.config.timeout || 5000;
    this.triggerResetDelay = typeof this.config.triggerResetDelay === 'number' ? this.config.triggerResetDelay : 500;
    this.directControlPort = this.config.directControlPort || 3000;

    this.buttonServices = [];
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 };
    this.connected = false;
    this.socket = null;
    this.isShuttingDown = false;

    this.heartbeatInterval = null;
    this.lastHeartbeatAck = Date.now();

    // LIFX client
    this.lifx = new LifxClient();
    this.lifx.init();
    this.lifx.on('light-new', light => {
      this.log(`Discovered LIFX bulb: ${light.id} (${light.address})`);
    });
    this.lifx.on('error', err => {
      this.log(`LIFX error: ${err.message}`);
    });

    // HTTP server
    this.app = express();
    this.app.use(express.json());
    this.server = null;

    // LED colors
    this.modeColors = {
      yellow: { r: 255, g: 255, b: 0 },
      red: { r: 255, g: 0, b: 0 },
      blue: { r: 0, g: 0, b: 255 },
      green: { r: 0, g: 255, b: 0 },
      purple: { r: 128, g: 0, b: 128 },
      white: { r: 255, g: 255, b: 255 }
    };
    this.colorCycle = ['red', 'green', 'blue', 'yellow', 'purple', 'white'];
    this.currentColorIndex = 0;

    this.buttonMappings = this.config.buttonMappings || [];
    this.log(`Config loaded: ${JSON.stringify(this.config)}`);

    if (!this.api || !this.api.hap) {
      this.log('Error: Homebridge API or HAP is undefined');
      return;
    }

    this.log('IPortSMButtonsPlatform initialized (LIFX only, with heartbeat)');

    this.startDirectControlServer();
    this.connect();

    this.api.on('didFinishLaunching', () => {
      this.log('Homebridge finished launching');
      this.accessories(accs => {
        this.api.registerPlatformAccessories('homebridge-iport-sm-buttons-lan', 'IPortSMButtonsLAN', accs);
      });
    });

    this.api.on('shutdown', () => {
      this.isShuttingDown = true;
      this.log('Homebridge shutting down, closing socket and HTTP server');
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      if (this.socket) this.socket.destroy();
      if (this.server) this.server.close();
      try { this.lifx.destroy(); } catch (e) {}
    });
  }

  // ---------------- iPort TCP ----------------
  connect() {
    if (!this.ip) {
      this.log.error('No IP configured for iPort device');
      return;
    }

    this.socket = new net.Socket();
    this.socket.setTimeout(this.timeout);

    this.socket.connect(this.port, this.ip, () => {
      if (!this.connected) this.log(`Connected to ${this.ip}:${this.port}`);
      this.connected = true;
      this.lastHeartbeatAck = Date.now();

      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 60000); // every 60s

      this.queryLED();
    });

    this.socket.on('data', data => {
      const str = data.toString().trim();
      this.lastHeartbeatAck = Date.now();

      try {
        const json = JSON.parse(str);
        if (json.led) this.parseAndSetLedFromString(String(json.led));
        if (json.events) {
          json.events.forEach(event => {
            const keyNum = parseInt(event.label.split(' ')[1], 10) - 1;
            const state = parseInt(event.state, 10);
            this.handleButtonEvent(keyNum, state);
          });
        }
      } catch (e) {
        if (str.includes('led=')) {
          const ledValue = str.split('led=')[1]?.trim();
          if (ledValue) this.parseAndSetLedFromString(ledValue);
        }
      }
    });

    this.socket.on('error', () => this.reconnect());
    this.socket.on('close', () => {
      if (this.connected) this.log('Connection closed');
      this.connected = false;
      this.reconnect();
    });
    this.socket.on('timeout', () => this.socket.destroy());
  }

  sendHeartbeat() {
    if (!this.connected || this.isShuttingDown) return;

    const now = Date.now();
    if (now - this.lastHeartbeatAck > 120000) { // 2 minutes without reply
      this.log('Heartbeat missed — reconnecting');
      this.reconnect();
      return;
    }
    this.queryLED(); // sends "led=?" as keepalive
  }

  reconnect() {
    if (this.isShuttingDown) return;
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    if (this.socket) {
      try { this.socket.destroy(); } catch (e) {}
      this.socket = null;
    }

    setTimeout(() => {
      if (!this.isShuttingDown) {
        this.log('Reconnecting to iPort...');
        this.connect();
      }
    }, 2000);
  }

  parseAndSetLedFromString(ledValue) {
    try {
      const s = String(ledValue).trim();
      const padded = s.padStart(9, '0').substr(0, 9);
      this.ledColor = {
        r: parseInt(padded.substr(0, 3), 10),
        g: parseInt(padded.substr(3, 3), 10),
        b: parseInt(padded.substr(6, 3), 10)
      };
    } catch {}
  }

  // ---------------- Button events ----------------
  handleButtonEvent(buttonIndex, state) {
    if (!this.connected || this.isShuttingDown) return;
    const bs = this.buttonStates[buttonIndex];

    if (state === 1) {
      bs.state = 1;
      bs.lastPress = Date.now();
    } else if (state === 0 && bs.state === 1) {
      bs.state = 0;
      this.triggerButtonEvent(buttonIndex);
    }
  }

  triggerButtonEvent(buttonIndex) {
    if (this.isShuttingDown) return;
    this.log(`Button ${buttonIndex + 1} triggered single press`);
    this.executeButtonAction(buttonIndex + 1);
  }

  // ---------------- Action execution ----------------
  executeButtonAction(buttonNumber) {
    if (buttonNumber === 10) {
      this.cycleLEDColor();
      return;
    }

    const actions = this.buttonMappings.filter(a => a.buttonNumber === buttonNumber);
    if (actions.length === 0) return;

    const currentMode = this.getCurrentMode();
    for (const action of actions) {
      if (action.modeColor !== 'any' && action.modeColor !== currentMode) continue;
      if (action.actionType === 'lifx') this.handleLifxAction(action);
    }
  }

  handleLifxAction(action) {
    const ids = Array.isArray(action.targetId) ? action.targetId : [action.targetId];
    ids.forEach(id => {
      const bulb = this.lifx.light(id);
      if (!bulb) return;
      if (action.action === 'on') bulb.on(0);
      else if (action.action === 'off') bulb.off(0);
      else if (action.action === 'brightness') {
        bulb.getState((err, state) => {
          if (err) return;
          bulb.color(state.hue || 0, state.saturation || 0, Math.max(0, Math.min(100, action.value)), state.kelvin || 3500, 0);
        });
      }
    });
  }

  cycleLEDColor() {
    this.currentColorIndex = (this.currentColorIndex + 1) % this.colorCycle.length;
    const colorName = this.colorCycle[this.currentColorIndex];
    const color = this.modeColors[colorName];
    this.setLED(color.r, color.g, color.b);
  }

  getCurrentMode() {
    let { r, g, b } = this.ledColor;
    if (r === 0 && g === 0 && b === 0) return 'off';
    const max = Math.max(r, g, b);
    r = Math.round((r / max) * 255);
    g = Math.round((g / max) * 255);
    b = Math.round((b / max) * 255);
    for (const mode in this.modeColors) {
      const mc = this.modeColors[mode];
      if (r === mc.r && g === mc.g && b === mc.b) return mode;
    }
    return 'unknown';
  }

  // ---------------- LED control ----------------
  setLED(r, g, b) {
    if (!this.connected || this.isShuttingDown) return;
    const cmd = `\rled=${r.toString().padStart(3, '0')}${g.toString().padStart(3, '0')}${b.toString().padStart(3, '0')}\r`;
    try { this.socket.write(cmd); } catch {}
    this.ledColor = { r, g, b };
  }

  queryLED() {
    if (!this.connected || this.isShuttingDown) return;
    try { this.socket.write('\rled=?\r'); } catch {}
  }

  // ---------------- Homebridge Accessories ----------------
  accessories(callback) {
    const PlatformAccessory = this.api.platformAccessory;
    const uuidStr = this.api.hap.uuid.generate(this.config.name || 'iPort SM Buttons LAN');
    this.accessory = new PlatformAccessory(this.config.name || 'iPort SM Buttons LAN', uuidStr);

    this.buttonServices = [];
    for (let i = 1; i <= 10; i++) {
      const btn = this.accessory.addService(
        this.api.hap.Service.StatelessProgrammableSwitch,
        `Button ${i}`, `button${i}`
      );
      if (this.api.hap.Characteristic.ServiceLabelIndex) {
        btn.setCharacteristic(this.api.hap.Characteristic.ServiceLabelIndex, i);
      }
      this.buttonServices[i - 1] = btn;
    }
    callback([this.accessory]);
  }

  configureAccessory(accessory) {
    this.accessory = accessory;
  }

  // ---------------- HTTP Server ----------------
  startDirectControlServer() {
    this.app.post('/action/button/:buttonNumber', (req, res) => {
      const buttonNumber = parseInt(req.params.buttonNumber, 10);
      this.executeButtonAction(buttonNumber);
      res.status(200).json({ success: true });
    });
    this.server = this.app.listen(this.directControlPort, '127.0.0.1', () => {
      this.log(`Direct control HTTP server running on http://127.0.0.1:${this.directControlPort}`);
    });
  }
}

module.exports = (api) => {
  console.log('Registering IPortSMButtonsLAN platform (LIFX + heartbeat)');
  api.registerPlatform('homebridge-iport-sm-buttons-lan', 'IPortSMButtonsLAN', IPortSMButtonsPlatform);
};
