import { Server, Socket } from 'socket.io';

class SocketService {
    private io: Server;
    private static instance: SocketService;

    constructor(io: Server) {
        this.io = io;
        SocketService.instance = this;
        this.initialize();
    }

    public static getInstance(): SocketService {
        return SocketService.instance;
    }

    private initialize() {
        this.io.on('connection', (socket: Socket) => {
            console.log('User connected:', socket.id);

            socket.on('disconnect', () => {
                console.log('User disconnected:', socket.id);
            });

            // Join offer room
            socket.on('join_offer', (offerId: string) => {
                socket.join(`offer_${offerId}`);
                console.log(`User ${socket.id} joined offer_${offerId}`);
            });

            // Join sellers room
            socket.on('join_sellers', () => {
                socket.join('sellers');
                console.log(`User ${socket.id} joined sellers room`);
            });

            // Join store room (for real-time updates within a store dashboard)
            socket.on('join_store', (storeId: string) => {
                socket.join(`store_${storeId}`);
                console.log(`User ${socket.id} joined store_${storeId}`);
            });

            socket.on('leave_store', (storeId: string) => {
                socket.leave(`store_${storeId}`);
                console.log(`User ${socket.id} left store_${storeId}`);
            });

            // Location update
            socket.on('send_location', (data: { offerId: string; userId: string; lat: number; lng: number }) => {
                // Broadcast to everyone in the room except sender
                socket.to(`offer_${data.offerId}`).emit('receive_location', {
                    userId: data.userId,
                    lat: data.lat,
                    lng: data.lng
                });
            });

            // New message relay (if client sends via socket directly)
            socket.on('send_message', (data: { offerId: string; message: any }) => {
                socket.to(`offer_${data.offerId}`).emit('new_message', data.message);
            });
        });
    }

    public emitToOffer(offerId: string, event: string, data: any) {
        this.io.to(`offer_${offerId}`).emit(event, data);
    }

    public emitToStore(storeId: string, event: string, data: any) {
        this.io.to(`store_${storeId}`).emit(event, data);
    }

    public broadcastToSellers(event: string, data: any) {
        this.io.to('sellers').emit(event, data);
    }
}

export default SocketService;
