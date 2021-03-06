'use strict';

//require("babel-polyfill");
//let Promise = require('./bluebird/js/browser/bluebird.js');

let events = require('./events.js');

let msgpack = require('./msgpack.js');
let sha256 = require('./sha256.js');

class TerminalLine {
	constructor (message) {
		this.element = document.createElement('line');

		this.setMessage(message);
	}

	setMessage (message) {
		this.element.innerHTML = message;
	}

	getElement () {
		return this.element;
	}
};

class TerminalCommandLine {
	constructor () {
		this.element = document.createElement('inputline');
		this.prompt = document.createElement('prompt');
		this.input = document.createElement('input');

		this.input.className = 'command';

		this.element.appendChild(this.prompt);
		this.element.appendChild(this.input);
	}

	setDisabled (disabled) {
		this.input.setAttribute('disabled', disabled);
	}

	setAutofocus () {
		this.input.setAttribute('autofocus', true);
	}

	setInput (message) {
		this.input.value = message;
	}

	setPrompt (prompt) {
		this.prompt.innerText = prompt;
	}

	getElement () {
		return this.element;
	}
};

class TerminalLineFeed {
	constructor (output) {
		this.lineFeed = [];
		this.output = output;
	}

	push (line) {
		this.output.appendChild(line.getElement());
		this.lineFeed.push(line);
	}

	remove (line) {
		this.output.removeChild(line.getElement());

		let itemPos = this.lineFeed.indexOf(line);

		if (~itemPos) {
			this.lineFeed = Array.prototype.concat.call(
				this.lineFeed.slice(0, itemPos),
				this.lineFeed.slice(itemPos + 1, this.lineFeed.length - 1)
			);
		}
	}

	removeAllLines () {
		this.lineFeed.forEach(line => this.remove(line));
	}

	removeLastPartial () {
		let lastCommandLine;

		for (let i = this.lineFeed.length; i >= 0; --i) {
			if (this.lineFeed[i] instanceof TerminalCommandLine) {
				lastCommandLine = this.lineFeed[i];
				break;
			}
		}

		if (lastCommandLine === undefined) return;

		this.lineFeed.slice(this.lineFeed.indexOf(lastCommandLine)).forEach(line => {
			this.remove(line);
		});
	}
}

class Terminal extends events {
	constructor () {
		super();

		this.init();

		this.registerEvents();
	}

	init () {
		this.prefixMeta = {
			name: 'nobody',
			instance: 'apx',
			uri: '~'
		};

		this.container = this._initContainer();

		this.command = this.container.querySelector('inputline .command');
		this.output = this.container.querySelector('output');

		this.lineFeed = new TerminalLineFeed(this.output);
		this.commandFeed = [];
	}

	_inputLine () {
		return new TerminalCommandLine ();
	}

	_getPromptPrefix () {
		return this.prefixMeta.name +
		       '@' + this.prefixMeta.instance +
		       ':' + this.prefixMeta.uri + '$';
	}
	_commitPromptPrefix () {
		let promptPrefix = this._getPromptPrefix();

		this.inputLine.setPrompt(promptPrefix);
	}

	_initContainer () {
		let container = document.createElement('cream');
		container.className = 'box';

		this.output = document.createElement('output');

		this.inputLine = this._inputLine();
		this.inputLine.setAutofocus(true);

		this._commitPromptPrefix();

		document.body.appendChild(container);

		container.appendChild(this.output);
		container.appendChild(this.inputLine.getElement());

		return container;
	}

	registerEvents() {
		this.command.addEventListener('keydown', e => {
			if (e.metaKey) {
				e.preventDefault();

				switch (e.keyCode) {
					case 75: return this.clearTerminal();
					case 76: return this.partialClearTerminal();
				}
			}

			if (e.keyCode === 13) {
				// jump list
				switch (this.command.value) {
					case 'clear':
						return this.resetTerminal();
				}

				this.disableTerminal();
				this.emit('command', this.command.value);
			}
		}, true);
	}

	// write partial message, non-exit
	write (msg) {
		let fakeInputLine = new TerminalCommandLine();

		fakeInputLine.setDisabled(true);
		fakeInputLine.setInput(this.command.value);
		fakeInputLine.setPrompt(this._getPromptPrefix());

		this.lineFeed.push(fakeInputLine);

		this.writeRaw(msg);
	}

	writeRaw (msg) {
		msg = msg.split('\n').map(line => line.trim());
		msg = msg.map(line => new TerminalLine(line));

		msg.forEach(line => this.lineFeed.push(line));
	}

	// quit command
	commit () {
		this.command.value = '';
		this.command.disabled = false;

		this.command.focus();
		this.command.scrollIntoView();
	}

	// divers commands
	clearTerminal () {
		this.lineFeed.removeAllLines();
	}

	partialClearTerminal () {
		this.lineFeed.removeLastPartial();
	}

	resetTerminal () {
		this.clearTerminal();
		this.command.value = '';
	}

	disableTerminal () {
		this.command.disabled = true;
	}

	destroy () {
		// clear eventing
		this.off();

		// clear line references
		this.clearTerminal();

		// remove DOM elements
		document.body.removeChild(this.container);
	}
}

class apx extends events {
	constructor () {
		super();

		this.helpers = {
			bsd16 (arr) {
				let c = 0,
					i = 0,
					l = arr.length;

				for (; i < l; i++) c = (((((c >>> 1) + ((c & 1) << 15)) | 0) + (arr[i] & 0xff)) & 0xffff) | 0;

				return c;
			},

			checkedChunk (seed) {
				return String.fromCharCode(...msgpack.encode(seed));
			}
		};

		this.registerRealtime();

		this.setupTTY();

		this.reactiveKeychain();
	}

	setupTTY () {
		this.initTerminal();
		this.initKeychain();

		if (localStorage.id) {
			this.handshake();
		}
	}

	reset () {
	}

	initKeychain () {
		this.alice = {};

		this.alice.keypair = sodium.crypto_box_keypair();
		this.alice.nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);

		let secret = String(location.hash.slice(1));

		if (secret === '') {
			this.terminal.writeRaw('Bad secret');
			this.terminal.disableTerminal();

			throw new Error();
		}

		secret = sha256(secret);

		this.alice.secretHash = secret;

		this.alice.authedHandshake = sodium.crypto_auth(this.alice.nonce, secret);
	}

	reactiveKeychain () {
		window.addEventListener('hashchange', () => {
			this.terminal.destroy();
			this.terminal = null;

			setTimeout(() => this.setupTTY());
		});
	}

	registerRealtime () {
		this.io = io({
			path: '/io'
		});

		let writeAndFlush = msg => {
			this.terminal.write(msg);
			this.terminal.commit();
		};

		this.io.on('err', writeAndFlush);
		this.io.on('info', writeAndFlush);

		this.io.on('exec', cipher => {
			const msg = msgpack.decode(sodium.crypto_box_open_easy(Uint8Array.from(cipher), this.bob.nonce, this.bob.publicKey, this.alice.keypair.privateKey));

			writeAndFlush(msg);
		});

		this.io.on('post-auth', (user, postAuth) => {
			if (sodium.crypto_auth_verify(Uint8Array.from(postAuth), this.bob.nonce, this.alice.secretHash)) {
				this.authenticated = true;

				this.terminal.write(`Welcome, ${user}.`);
				this.terminal.commit();
			}
		});

		this.io.on('rpc', data => this.handleRPC(data));
	}

	handleRPC (data) {
		try {
			data = msgpack.decode(new Uint8Array(data));

			switch (data.type) {
				case 'handshake':
					return this.digestHandshake(data.publicKey, data.nonce);
			}
		} catch(e) {
			console.warn('Received invalid RPC frame.', e.stack);
		}
	}

	digestHandshake (publicKey, nonce) {
		this.bob = {
			publicKey: Uint8Array.from(publicKey),
			nonce: Uint8Array.from(nonce)
		};

		let cipher = sodium.crypto_box_easy(
			'init',
			this.alice.nonce,
			this.bob.publicKey,
			this.alice.keypair.privateKey
		);

		let packet = this.helpers.checkedChunk([...cipher]);

		this.io.emit('post-handshake', packet);
	}

	handshake () {
		let user = localStorage.id;

		let seed = {
			user: user,
			nonce: [...this.alice.nonce],
			publicKey: [...this.alice.keypair.publicKey],
			authedHandshake: [...this.alice.authedHandshake]
		};

		let packet = this.helpers.checkedChunk(seed);

		this.io.emit('handshake', packet);
	}

	bufcmp (buf1, buf2) {
		if (buf1.length !== buf2.length) return false;

		for(let i = 0; i < buf2.length; ++i)
			if (buf1[i] !== buf2[i]) return false;

		return true;
	}

	initTerminal () {
		this.terminal = new Terminal();

		this.terminal.on('command', msg => {
			let _msg = msg.trim().split(' ');

			if (this.authenticated) {
				let plaintext = JSON.stringify(_msg);

				let cipher = sodium.crypto_box_easy(
					plaintext,
					this.alice.nonce,
					this.bob.publicKey,
					this.alice.keypair.privateKey
				);

				let packet = this.helpers.checkedChunk(cipher);

				const tag = sodium.crypto_auth(packet, this.alice.secretHash);

				this.io.emit('command', [...cipher], [...tag]);
			} else {
				if (_msg.length !== 2 || _msg[0] !== 'login') {
					this.terminal.write('Not authenticated.');
					this.terminal.commit();
				} else {
					localStorage.id = _msg[1];

					this.handshake();
				}
			}
		});
	}
};

new apx();
