///<reference path='boris-typedefs/node/node.d.ts'/>
///<reference path='boris-typedefs/socket.io/socket.io.d.ts'/>
///<reference path='typedefs/ot.d.ts'/>

import User = require("./user_model");
import IUser = require("./user_interface");
import Config = require("./config");
import RedisHandler = require("./redis_handler");
import RedisHelper = require("./redis_helper");
import ChildProcess = require("child_process");
import Ot = require("ot");

interface ISocketCustom extends SocketIO.Socket {
	once(event:string, listener:Function):void;
	removeListener(event:string, listener:Function):void;
	removeAllListeners():void;
	disconnect():void;
	handler: SocketHandler;
	handshake: {
		address: string;
	}
}

enum ReadyState{
	New,
	Active,
	Destroyed
}

class SocketHandler {
	public socket:ISocketCustom;
	public otServer: Ot.Server;
	public redis:RedisHandler;
	public user:IUser = null;
	public sessCode:string;
	public readyState:ReadyState = ReadyState.New;
	private docIds:string[] = [];

	public static onConnection(socket:SocketIO.Socket) {
		var handler = new SocketHandler(socket);
		handler.socket.handler = handler;
	}

	constructor(socket:SocketIO.Socket) {

		// Set up the socket
		this.socket = <ISocketCustom> socket;
		this.listen();
		this.log("New Connection", this.socket.handshake.address);

		// Concurrently ask socket for its sessCode and load user from MongoDB
		var _socketInitDone = false;
		var _mongoInitDone = false;
		var _sessCodeGuess:string = null;

		// Send the init message over the socket and wait for a response
		this.socket.emit("init");
		this.socket.once("init", (data)=> {
			_sessCodeGuess = data && data.sessCode;
			_socketInitDone = true;
			this.log("Claimed sessCode", _sessCodeGuess);

			// Attempt to continue to callback
			if (_socketInitDone && _mongoInitDone) {
				this.initSessCode(_sessCodeGuess);
			}
		});

		// Load the user from MongoDB
		var sess = this.socket.request.session;
		var userId = sess && sess.passport && sess.passport.user;
		if (userId) {
			User.findById(userId, (err, user)=> {
				if (err) return this.log("MONGO ERROR", err);
				this.user = user;
				_mongoInitDone = true;
				this.log("Loaded from Mongo");

				// Attempt to continue to callback
				if (_socketInitDone && _mongoInitDone) {
					this.initSessCode(_sessCodeGuess);
				}
			});
		} else {
			_mongoInitDone = true;
		}
	}

	private listen() {
		// Prevent duplicate listeners
		this.unlisten();

		// Make listeners on the socket
		this.socket.on("disconnect", this.onDisconnect);
		this.socket.on("enroll", this.onEnroll);
		this.socket.on("update_students", this.onUpdateStudents);
		this.socket.on("ot:subscribe", this.onOtSubscribe);
		this.socket.on("ot:change", this.onOtChange);
		this.socket.on("ot:cursor", this.onOtCursor);
		this.socket.on("*", this.onInput);

		// Make listeners on Redis
		if (this.redis) {
			this.redis.on("data", this.onOutput);
			this.redis.on("destroy-u", this.onDestroyU);
			this.redis.on("ot:doc", this.onOtDoc);
			this.redis.on("ot:ack", this.onOtAck);
			this.redis.on("ot:broadcast", this.onOtBroadcast);
		}
	}

	private unlisten():void {
		this.socket.removeAllListeners();
		if (this.redis) {
			this.redis.removeAllListeners();
		}
	}

	private log(..._args:any[]):void {
		var args = Array.prototype.slice.apply(arguments);
		args.unshift("[" + this.socket.id + "]");
		console.log.apply(this, args);
	}

	private sendData(message:string):void {
		this.socket.emit("data", {
			type: "stdout",
			data: message+"\n"
		});
	}

	//// LISTENER FUNCTIONS ////

	private onDisconnect = ():void => {
		this.readyState = ReadyState.Destroyed;
		this.unlisten();
		if (this.redis) this.redis.destroyD("Client Disconnect");
		this.log("Destroying: Client Disconnect");
	};

	private onDestroyU = (message:string):void=> {
		this.readyState = ReadyState.Destroyed;
		this.unlisten();
		this.socket.emit("destroy-u", message);
		this.socket.disconnect();
		this.log("Destroying:", message);
	};

	private onOtSubscribe = (obj) => {
		if (!obj
			|| typeof obj.docId === "undefined")
			return;
		if (!this.redis) return;

		console.log("here")
		this.docIds.push(obj.docId);
		this.redis.getOtDoc(obj.docId);
	}

	private onOtChange = (obj) => {
		console.log("ot in:", obj);
		if (!obj
			|| typeof obj.op === "undefined"
			|| typeof obj.rev === "undefined"
			|| typeof obj.docId === "undefined")
			return;
		if (this.docIds.indexOf(obj.docId) === -1) return;

		var op = Ot.TextOperation.fromJSON(obj.op);
		this.redis.receiveOperation(obj.docId, obj.rev, op);
	};

	private onOtCursor = (cursor) => {
		if (!cursor) return;
		// this.socket.emit("ot:cursor", cursor);
	};

	private onOtDoc = (docId, rev, content) => {
		this.socket.emit("ot:doc", {
			docId: docId,
			rev: rev,
			content: content
		});
	};

	private onOtAck = (docId) => {
		if (this.docIds.indexOf(docId) > -1) {
			this.socket.emit("ot:ack", {
				docId: docId
			});
		}
	};

	private onOtBroadcast = (docId, ops) => {
		if (this.docIds.indexOf(docId) > -1) {
			this.socket.emit("ot:broadcast", {
				docId: docId,
				ops: ops
			});
		}
	};

	private onInput = (obj)=> {
		if (!this.redis) return;

		// Blindly pass all data from the client to Redis
		this.redis.input(obj.data[0], obj.data[1]);
	};

	private onOutput = (name, data) => {
		// Blindly pass all data from Redis to the client
		this.socket.emit(name, data);
	};

	private onEnroll = (obj)=> {
		if (!this.user || !obj) return;
		var program = obj.program;
		if (!program) return;
		console.log("Enrolling", this.user.consoleText, "in program", program);
		this.user.program = program;
		this.user.save((err)=> {
			if (err) console.log("MONGO ERROR", err);
			this.sendData("Successfully enrolled");
		});
	};

	private onUpdateStudents = (obj)=> {
		if (!obj) return;
		if (!this.user)
			return this.sendData("Please sign in first");
		if (!this.user.instructor || this.user.instructor.length === 0)
			return this.sendData("You're not registered as an instructor");
		if (this.user.instructor.indexOf(obj.program) === -1)
			return this.sendData("Check the spelling of your program name");

		console.log("Updating students in program", obj.program);
		this.sendData("Updating students...");
		ChildProcess.execFile(
			__dirname+"/../src/program_update.sh",
			[this.user.parametrized, obj.program, Config.mongodb.db],
			(err, stdout, stderr)=> {
				if (err) {
					console.log("ERROR ON UPDATE STUDENTS", err, stdout, stderr);
					this.sendData("Error while updating students: " + err);
				} else {
					this.sendData("Successfully updated students");
				}
			}
		);
	};

	//// SESSION INITIALIZATION FUNCTIONS ////

	private initSessCode(sessCodeGuess:string) {
		if (this.readyState !== ReadyState.New) return;

		RedisHelper.getNewSessCode(sessCodeGuess, this.onSessCode);
	}

	private onSessCode = (err, sessCode:string, needsOctave:boolean)=> {
		if (err) return this.log("REDIS ERROR", err);
		if (this.readyState !== ReadyState.New) return;
		this.sessCode = sessCode;

		// We have our sessCode.  Log it.
		this.log("SessCode Ready", sessCode);

		if (needsOctave) {
			// Tell the client and make the Octave session.
			this.socket.emit("sesscode", {
				sessCode: sessCode
			});
			RedisHelper.askForOctave(sessCode, this.user, this.onOctaveRequested);
		} else {
			// Make Redis, update ready state, and send prompt message to client
			this.redis = new RedisHandler(this.sessCode);
			this.readyState = ReadyState.Active;
			this.listen();
			this.socket.emit("prompt", {});
		}
	};

	private onOctaveRequested = (err)=> {
		if (err) return this.log("REDIS ERROR", err);

		// Make Redis
		this.redis = new RedisHandler(this.sessCode);
		this.listen();

		// Check and update ready state
		switch (this.readyState) {
			case ReadyState.Destroyed:
				this.redis.destroyD("Client Gone");
				this.unlisten();
				break;
			case ReadyState.New:
				this.readyState = ReadyState.Active;
				break;
			default:
				break;
		}
	};
}

export = SocketHandler;