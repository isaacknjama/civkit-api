var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { postHoldinvoice, postFullAmountInvoice, handleFiatReceived } from './invoiceService.js';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
config();
const prisma = new PrismaClient();
function addOrderAndGenerateInvoice(orderData) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('Starting addOrderAndGenerateInvoice with data:', orderData);
        const { customer_id, order_details, amount_msat, currency, payment_method, status, type, premium = 0 } = orderData;
        try {
            // Insert the order into the database
            const order = yield prisma.order.create({
                data: {
                    customer_id,
                    order_details,
                    amount_msat,
                    currency,
                    payment_method,
                    status,
                    type,
                    premium
                }
            });
            console.log('Order inserted:', order);
            // Post the hold invoice
            console.log('Generating hold invoice');
            const holdInvoiceData = yield postHoldinvoice(amount_msat, `Hold Invoice for Order ${order.order_id}`, order_details);
            console.log('Hold invoice generated:', holdInvoiceData);
            if (!holdInvoiceData || !holdInvoiceData.bolt11 || !holdInvoiceData.payment_hash) {
                throw new Error('Invalid hold invoice data received: ' + JSON.stringify(holdInvoiceData));
            }
            // Save hold invoice data to the database
            const holdInvoice = yield prisma.invoice.create({
                data: {
                    order_id: order.order_id,
                    bolt11: holdInvoiceData.bolt11,
                    amount_msat,
                    status: holdInvoiceData.status || 'pending',
                    description: order_details,
                    payment_hash: holdInvoiceData.payment_hash,
                    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1 day from now
                    invoice_type: 'hold'
                }
            });
            console.log('Hold invoice saved to database:', holdInvoice);
            let fullInvoiceData = null;
            if (type === 1) { // For sell orders
                console.log('Generating full invoice for sell order');
                fullInvoiceData = yield postFullAmountInvoice(amount_msat, `Full Invoice for Order ${order.order_id}`, order_details, order.order_id, type);
                if (!fullInvoiceData || !fullInvoiceData.bolt11) {
                    throw new Error('Failed to generate full amount invoice');
                }
                // Save full invoice data to the database
                const fullInvoice = yield prisma.invoice.create({
                    data: {
                        order_id: order.order_id,
                        bolt11: fullInvoiceData.bolt11,
                        amount_msat,
                        status: 'pending',
                        description: order_details,
                        payment_hash: fullInvoiceData.payment_hash,
                        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1 day from now
                        invoice_type: 'full'
                    }
                });
                console.log('Full invoice saved to database:', fullInvoice);
            }
            return { order, holdInvoice: holdInvoiceData, fullInvoice: fullInvoiceData };
        }
        catch (error) {
            console.error('Transaction failed:', error);
            throw error;
        }
    });
}
function processTakeOrder(orderId, holdInvoice) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Update the order to mark as taken
            const updatedOrder = yield prisma.order.update({
                where: { order_id: orderId },
                data: { status: 'depositing' }
            });
            return { message: "deposit in progress", order: updatedOrder };
        }
        catch (error) {
            throw error;
        }
    });
}
function generateTakerInvoice(orderId, takerDetails, customer_id) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Retrieve the order type and amount from orders table
            const order = yield prisma.order.findUnique({
                where: { order_id: orderId }
            });
            if (!order) {
                throw new Error('No order found for this order ID');
            }
            const orderType = order.type;
            const orderAmountMsat = order.amount_msat;
            // Generate hold invoice for 5% of the order amount
            const holdInvoiceAmount = Math.round(orderAmountMsat * 0.05);
            console.log(`Generating hold invoice for order ${orderId} with amount ${holdInvoiceAmount} msat`);
            const holdInvoiceData = yield postHoldinvoice(holdInvoiceAmount, `Order ${orderId} for Taker`, takerDetails.description);
            // Insert hold invoice into the database
            const holdInvoice = yield prisma.invoice.create({
                data: {
                    order_id: orderId,
                    bolt11: holdInvoiceData.bolt11,
                    amount_msat: holdInvoiceAmount,
                    description: holdInvoiceData.description,
                    status: 'pending',
                    payment_hash: holdInvoiceData.payment_hash,
                    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1 day from now
                    invoice_type: 'hold',
                    user_type: 'taker'
                }
            });
            let fullInvoiceData = null;
            if (orderType === 1) { // For sell orders
                try {
                    console.log(`Generating full invoice for sell order ${orderId} with amount ${orderAmountMsat} msat`);
                    fullInvoiceData = yield postFullAmountInvoice(orderAmountMsat, `Order ${orderId} Full Amount`, takerDetails.description, orderId, orderType);
                    if (!fullInvoiceData || !fullInvoiceData.bolt11) {
                        throw new Error('Failed to generate full amount invoice: Invalid response data');
                    }
                    // Insert full invoice into the database
                    fullInvoiceData = yield prisma.invoice.create({
                        data: {
                            order_id: orderId,
                            bolt11: fullInvoiceData.bolt11,
                            amount_msat: orderAmountMsat,
                            description: fullInvoiceData.description,
                            status: 'pending',
                            payment_hash: fullInvoiceData.payment_hash,
                            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1 day from now
                            invoice_type: 'full',
                            user_type: 'taker'
                        }
                    });
                    console.log(`Full invoice inserted into database for order ${orderId}:`, fullInvoiceData);
                }
                catch (error) {
                    console.error(`Error generating full invoice for order ${orderId}:`, error);
                    throw error;
                }
            }
            // Update the order status and taker_customer_id
            const updatedOrder = yield prisma.order.update({
                where: { order_id: orderId },
                data: {
                    status: 'depositing',
                    taker_customer_id: customer_id
                }
            });
            return {
                order: updatedOrder,
                holdInvoice,
                fullInvoice: fullInvoiceData
            };
        }
        catch (error) {
            console.error('Error in generateTakerInvoice:', error);
            throw error;
        }
    });
}
function checkAndUpdateOrderStatus(orderId, payment_hash) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const checkInvoiceStatus = yield queryInvoiceStatus(payment_hash);
            if (checkInvoiceStatus === 'paid') {
                const updatedOrder = yield prisma.order.update({
                    where: { order_id: orderId },
                    data: { status: 'bonds_locked' },
                });
                return updatedOrder;
            }
        }
        catch (error) {
            console.error('Error in checkAndUpdateOrderStatus:', error);
            throw error;
        }
    });
}
function handleFiatReceivedAndUpdateOrder(orderId) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield handleFiatReceived(orderId);
            console.log("Order status updated to indicate fiat received.");
        }
        catch (error) {
            console.error("Error updating order status:", error);
            throw error;
        }
    });
}
function updatePayoutStatus(orderId, status) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const updatedPayout = yield prisma.payout.updateMany({
                where: { order_id: orderId },
                data: { status }
            });
            if (updatedPayout.count === 0) {
                throw new Error('Failed to update payout status');
            }
            return updatedPayout;
        }
        catch (error) {
            throw error;
        }
    });
}
export { addOrderAndGenerateInvoice, processTakeOrder, generateTakerInvoice, checkAndUpdateOrderStatus, handleFiatReceivedAndUpdateOrder, updatePayoutStatus };
