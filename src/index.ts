
import { Socket, Server } from 'net';
const es = require('event-stream');
const airswarm = require('airswarm');
const addr = require('network-address');

type AirSwarm = Server & { peers: Array<Socket> };

import { randomString, Lookup } from './utils'

export interface EventArgs<T> {
  event: string;
  data?: T;
  sender?: string;
  created: number;
  peer?: Socket;
}

export type EventHandler<T> = (e: EventArgs<T>) => void;

export class EventSwarm {

  public readonly channel: string;
  public readonly id: string;

  private _handlers: Lookup<Array<EventHandler<any>>>;
  private _swarm: AirSwarm;
  private _ready: Promise<void>;

  private _closing: boolean;

  constructor({ channel }: { channel: string }) {
        
    if (!channel) {
      throw new Error(`A 'channel' must be provided!`);
    }

    this.channel = channel;

    this.id = randomString(32);

    this._handlers = {};

    let markAsReady: () => void;
    this._ready = new Promise<void>(resolve => {
      markAsReady = resolve;
    });
    this._swarm = airswarm(`${this.channel}`, this._onPeer.bind(this));
    this._swarm.on('listening', markAsReady);
  }

  public get address() {
    try {
      return `${addr()}:${this._swarm.address().port}`;
    } catch (err) {
      return null;
    }
  }

  public get peers() {
    return this._swarm.peers;
  }

  public on<T>(event: string, cb: EventHandler<T>): this {
    this._handlers[event] = this._handlers[event] || [];
    this._handlers[event].push(cb);

    return this;
  }

  public once<T>(event: string, cb: EventHandler<T>): this {
    this._handlers[event] = this._handlers[event] || [];
    this._handlers[event].push(e => {
      this.off(event);
      cb(e);
    });

    return this;
  }
  
  public off<T>(event: string): this;
  public off<T>(event: string, handler: EventHandler<T>): this;
  public off<T>(event: string, handler?: EventHandler<T>): this {
    if (!event) {
      throw new Error(`event name must be specified!`);
    }

    if (handler) {
      this._handlers[event].splice(this._handlers[event].indexOf(handler), 1);
    } else {
      this._handlers[event] = [];
    }

    return this;
  }

  public emit<T>(event: string, data?: T): this {
    return this.send(this.peers, event, data);
  }

  public send<T>(peers: Socket | Array<Socket>, event: string, data?: T): this {
    // Don't return this since events are pseudo-async...
    this._ready.then(() => {
      if (!Array.isArray(peers)) {
        peers = [peers];
      }

      const payload = JSON.stringify({
        event,
        data,
        sender: this.id,
        created: Date.now()
      }) + '\n';

      peers.forEach(peer => {
        peer.write(payload);
      });
    });

    return this;
  }

  public close() {
    this._closing = true; // Set flag to ignore the immenant disconnect events...
    this._swarm.close(); // Stop new connections...
    this._swarm.peers.forEach(peer => {
      peer.end(); // End existing connections...
    });
    this._handlers = {}; // Remove all handlers...
  }

  private _onPeer(peer: Socket) {
    let peerId: string;

    this.send(peer, 'event-swarm:connect', { id: this.id });
    this.on('event-swarm:connect', e => {
      if (e.peer === peer) peerId = e.sender;
    });

    peer
      .pipe(es.split()) // Split on newlines...
      .pipe(es.parse({ error: true })) // Parse each line as a JSON object...
      .on('data', this._handleEvent.bind(this, peer))
      .on('end', () => {
        if (this._closing) return;
        this._handleEvent(peer, {
          event: 'event-swarm:disconnect',
          data: { id: peerId },
          sender: peerId,
          created: Date.now()
        });
      });
  }

  private _handleEvent(peer: Socket, payload: EventArgs<any>) {
    payload.peer = peer;
    if (this._handlers[payload.event]) {
      this._handlers[payload.event].forEach(handler => {
        handler(payload);
      });
    }
  }
}