const net = require('net');
const express = require('express');
const LifxClient = require('node-lifx').Client;

console.log('Loading iPortSMButtonsLAN plugin (LIFX edition)');

class IPortSMButtonsPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    // network/config
    this.ip = this.config.ip || '192.168.2.12';
    this.port = this.config.port || 10001;
    this.timeout = this.config.timeout || 10000;
    this.reconnectDelay = this.config.reconnectDelay || 10000; // Start with 10 seconds
    this.maxReconnectDelay = this.config.maxReconnectDelay || 300000; // Max 5 minutes
    this.triggerResetDelay = typeof this.config.triggerResetDelay === 'number' ? this.config.triggerResetDelay : 500;
    this.directControlPort = this.config.directControlPort || 3000;

    // Enhanced connection management
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = this.config.maxReconnectAttempts || 10;
    this.lastDataReceived = 0;
    this.healthCheckInterval = null;

    this.buttonServices = [];
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 };
    this.connected = false;
    this.socket = null;
    this.isShuttingDown = false;
    this.keepAliveInterval = null;
    this.retryTimer = null;
    this.retryScheduled = false;

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

    this.log('IPortSMButtonsPlatform initialized (LIFX only)');

    this.startDirectControlServer();
    this.connect();

    this.api.on('didFinishLaunching', () => {
      this.log('Homebridge finished launching');
      this.accessories(accs => {
        this.log('Registering accessories after didFinishLaunching');
        this.api.registerPlatformAccessories('homebridge-iport-sm-buttons-lan', 'IPortSMButtonsLAN', accs);
      });
    });

    this.api.on('shutdown', () => {
      this.isShuttingDown = true;
      this.log('Homebridge shutting down, closing connections...');
      
      this.cleanupConnection();
      
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      
      if (this.server) {
        this.server.close();
      }
      
      try { 
        this.lifx.destroy(); 
      } catch (e) {
        this.log(`Error destroying LIFX client: ${e.message}`);
      }
    });
  }

  // ---------------- Enhanced iPort TCP Connection ----------------
  connect() {
    if (!this.ip) {
      this.log.error('No IP configured for iPort device');
      return;
    }

    // Clear any existing connection
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.log(`Connecting to ${this.ip}:${this.port}`);
    this.socket = new net.Socket();
    
    // Enhanced socket settings
    this.socket.setTimeout(10000); // 10 second timeout
    this.socket.setKeepAlive(true, 10000); // Keep-alive every 10 seconds
    this.socket.setNoDelay(true); // Disable Nagle's algorithm for real-time communication

    const connectionTimeout = setTimeout(() => {
      if (!this.connected) {
        this.log('Connection timeout');
        this.socket.destroy();
      }
    }, 15000);

    this.socket.connect(this.port, this.ip, () => {
      clearTimeout(connectionTimeout);
      this.log(`Connected to ${this.ip}:${this.port}`);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.retryScheduled = false;
      
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      
      // Start enhanced keep-alive
      this.startEnhancedKeepAlive();
    });

    this.socket.on('data', data => {
      this.handleDeviceData(data);
    });

    this.socket.on('error', err => {
      clearTimeout(connectionTimeout);
      this.log(`Socket error: ${err.message}`);
      this.handleDisconnection();
    });

    this.socket.on('close', () => {
      clearTimeout(connectionTimeout);
      this.log('Connection closed');
      this.handleDisconnection();
    });

    this.socket.on('timeout', () => {
      this.log('Socket timeout - device may be unresponsive');
      this.socket.destroy();
    });
  }

  handleDeviceData(data) {
    const str = data.toString().trim();
    this.lastDataReceived = Date.now();
    
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
  }

  handleDisconnection() {
    if (this.isShuttingDown) return;
    
    this.connected = false;
    this.cleanupConnection();
    
    // Exponential backoff for reconnection
    const baseDelay = this.reconnectDelay;
    const maxDelay = this.maxReconnectDelay;
    const delay = Math.min(maxDelay, baseDelay * Math.pow(2, Math.min(this.reconnectAttempts, 5)));
    
    this.reconnectAttempts++;
    this.retryScheduled = true;
    
    this.log(`Retrying connection in ${Math.round(delay / 1000)} seconds (attempt ${this.reconnectAttempts})...`);
    
    this.retryTimer = setTimeout(() => {
      this.retryScheduled = false;
      this.connect();
    }, delay);
  }

  startEnhancedKeepAlive() {
    // Clear any existing intervals
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    // Send keep-alive every 30 seconds (more frequent than manual recommendation)
    this.keepAliveInterval = setInterval(() => {
      if (this.connected && !this.isShuttingDown) {
        this.queryLED();
      }
    }, 30000);

    // Health check - verify we're receiving data
    this.healthCheckInterval = setInterval(() => {
      if (this.connected && !this.isShuttingDown) {
        const timeSinceLastData = Date.now() - (this.lastDataReceived || 0);
        
        // If no data received in 2 minutes, force reconnection
        if (timeSinceLastData > 120000) {
          this.log('Health check failed - no data received, reconnecting...');
          this.handleDisconnection();
        }
      }
    }, 60000); // Check every minute
  }

  cleanupConnection() {
    this.connected = false;
    
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  parseAndSetLedFromString(ledValue) {
    try {
      const s = String(ledValue).trim();
      const padded = s.padStart(9, '0').substr(0, 9);
      const newR = parseInt(padded.substr(0, 3), 10);
      const newG = parseInt(padded.substr(3, 3), 10);
      const newB = parseInt(padded.substr(6, 3), 10);
      this.ledColor = { r: newR, g: newG, b: newB };
    } catch (err) {
      // ignore
    }
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
    if (actions.length === 0) {
      this.log(`No actions configured for button ${buttonNumber}`);
      return;
    }

    const currentMode = this.getCurrentMode();
    this.log(`Current LED mode: ${currentMode}`);

    for (const action of actions) {
      if (action.modeColor !== 'any' && action.modeColor !== currentMode) {
        this.log(`Skipping action for button ${buttonNumber}, requires ${action.modeColor}`);
        continue;
      }
      if (action.actionType === 'lifx') {
        this.handleLifxAction(action);
      } else {
        this.log(`Unsupported actionType: ${action.actionType}`);
      }
    }
  }

  handleLifxAction(action) {
    const ids = Array.isArray(action.targetId) ? action.targetId : [action.targetId];
    ids.forEach(id => {
      const bulb = this.lifx.light(id);
      if (!bulb) {
        this.log(`LIFX bulb ${id} not found`);
        return;
      }
      if (action.action === 'on') {
        bulb.on(0, () => this.log(`Turned on LIFX ${id}`));
      } else if (action.action === 'off') {
        bulb.off(0, () => this.log(`Turned off LIFX ${id}`));
      } else if (action.action === 'brightness') {
        bulb.getState((err, state) => {
          if (err) {
            this.log(`Error getting state of LIFX ${id}: ${err.message}`);
            return;
          }
          const hue = state.hue || 0;
          const saturation = state.saturation || 0;
          const kelvin = state.kelvin || 3500;
          const brightness = Math.max(0, Math.min(100, action.value));
          bulb.color(hue, saturation, brightness, kelvin, 0, () => {
            this.log(`Set LIFX ${id} brightness to ${brightness}%`);
          });
        });
      }
    });
  }

  cycleLEDColor() {
    this.currentColorIndex = (this.currentColorIndex + 1) % this.colorCycle.length;
    const colorName = this.colorCycle[this.currentColorIndex];
    const color = this.modeColors[colorName];
    this.log(`Button 10 pressed: Cycling to ${colorName}`);
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
      const modeColor = this.modeColors[mode];
      if (r === modeColor.r && g === modeColor.g && b === modeColor.b) return mode;
    }
    return 'unknown';
  }

  // ---------------- LED control ----------------
  setLED(r, g, b) {
    if (!this.connected || this.isShuttingDown) return;
    const cmd = `\rled=${r.toString().padStart(3, '0')}${g.toString().padStart(3, '0')}${b.toString().padStart(3, '0')}\r`;
    try {
      this.socket.write(cmd);
      this.ledColor = { r, g, b };
    } catch (e) {}
  }

  queryLED() {
    if (!this.connected || this.isShuttingDown) return;
    try {
      this.socket.write('\rled=?\r');
    } catch (e) {}
  }

  // ---------------- Homebridge Accessories ----------------
  accessories(callback) {
    this.log('Setting up dummy accessories (for buttons only)');
    try {
      const PlatformAccessory = this.api.platformAccessory;
      const uuidStr = this.api.hap.uuid.generate(this.config.name || 'iPort SM Buttons LAN');
      this.accessory = new PlatformAccessory(this.config.name || 'iPort SM Buttons LAN', uuidStr);

      this.buttonServices = [];
      for (let i = 1; i <= 10; i++) {
        const buttonService = this.accessory.addService(
          this.api.hap.Service.StatelessProgrammableSwitch,
          `Button ${i}`, `button${i}`
        );
        if (this.api.hap.Characteristic.ServiceLabelIndex) {
          buttonService.setCharacteristic(this.api.hap.Characteristic.ServiceLabelIndex, i);
        }
        this.buttonServices[i - 1] = buttonService;
      }
      callback([this.accessory]);
    } catch (e) {
      this.log(`Error in accessories setup: ${e.message}`);
      callback([]);
    }
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
  console.log('Registering IPortSMButtonsLAN platform (LIFX only, with LED modes)');
  api.registerPlatform('homebridge-iport-sm-buttons-lan', 'IPortSMButtonsLAN', IPortSMButtonsPlatform);
};
