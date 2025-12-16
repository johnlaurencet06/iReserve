const Booking = require('../models/bookingModel')
const Room = require('../models/roomModel')
const mongoose = require('mongoose')

const now = () => new Date() //new Date() = current date & time () after => means it’s a function. This function returns the current time

const isAlignedTo30Min = (d) => {
	if (!(d instanceof Date)) return false
	return (d.getMinutes() % 30 === 0) && d.getSeconds() === 0 && d.getMilliseconds() === 0
}

// check overlapping bookings. Find bookings in the SAME ROOM where:start time ≤ new end time end time ≥ new start time That’s how overlapping time is detected
const hasOverlap = async (roomId, start, end, excludeId = null) => {
	const query = {
		room: roomId,
		startTime: { $lte: end },
		endTime: { $gte: start }
	}
	if (excludeId) query._id = { $ne: excludeId } //findOne() = find one matching record !! converts result into true or false
	const overlapping = await Booking.findOne(query)
	return !!overlapping
}

// Function to check if a room is currently booked and update its isAvailable status
const syncRoomAvailability = async (roomId) => {
    const nowDate = now();
    
    // Find any active booking for the given room ID
    const activeBooking = await Booking.findOne({
        room: roomId,
        startTime: { $lte: nowDate }, // Booking started before or at now
        endTime: { $gt: nowDate }     // Booking ends strictly AFTER now (critical check)
    });

    // Fetch the room to update
    const room = await Room.findById(roomId);

    if (room) {
        // If an active booking is found, the room is NOT available.
        const isCurrentlyAvailable = !activeBooking;
        if (room.isAvailable !== isCurrentlyAvailable) {
            room.isAvailable = isCurrentlyAvailable;
            await room.save();
        }
        return isCurrentlyAvailable;
    }
    return true; 
}

// GET all bookings
const getBookings = async (req, res) => {
	try {
		const bookings = await Booking.find().populate('room').sort({ createdAt: -1 })
		res.status(200).json(bookings)
	} catch (error) {
		res.status(500).json({ error: error.message })
	}
}

// GET single booking
const getBooking = async (req, res) => {
	const { id } = req.params
	if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: 'Booking not found' })

	try {
		const booking = await Booking.findById(id).populate('room')
		if (!booking) return res.status(404).json({ error: 'Booking not found' })
		res.status(200).json(booking)
	} catch (error) {
		res.status(500).json({ error: error.message })
	}
}

// GET bookings for a specific room for the current day
const getBookingsByRoom = async (req, res) => {
    const { roomId } = req.params 

    if (!mongoose.Types.ObjectId.isValid(roomId)) {
        return res.status(404).json({ error: 'Invalid Room ID' })
    }

    try {
        // --- Calculate start and end of the current day ---
        const today = new Date();
        
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

        const query = { 
            room: roomId,
            startTime: { $gte: startOfDay }, 
            endTime: { $lte: endOfDay }
        };

        const bookings = await Booking.find(query)
                                     .populate('room')
                                     .sort({ startTime: 1 }) 
        
        res.status(200).json(bookings)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
}

// create booking
const createBooking = async (req, res) => {
	const { roomId, userName, startTime, endTime } = req.body || {}

	if (!roomId || !userName || !startTime || !endTime) {
		return res.status(400).json({ error: 'roomId, userName, startTime and endTime are required' })
	}

	const start = new Date(startTime)
	const end = new Date(endTime)   
	if (isNaN(start) || isNaN(end) || start >= end) {
		return res.status(400).json({ error: 'Invalid startTime/endTime' })
	}

	if (!isAlignedTo30Min(start) || !isAlignedTo30Min(end)) {
		return res.status(400).json({ error: 'startTime and endTime must be aligned to 30-minute intervals (e.g., :00 or :30) and have zero seconds' })
	}

	try {
		if (!mongoose.Types.ObjectId.isValid(roomId)) return res.status(404).json({ error: 'Room not found' })
		const room = await Room.findById(roomId)
		if (!room) return res.status(404).json({ error: 'Room not found' })

		const overlap = await hasOverlap(roomId, start, end)
		if (overlap) return res.status(409).json({ error: 'Room already booked for given times' })

		const booking = await Booking.create({ room: roomId, userName, startTime: start, endTime: end })

		
		await syncRoomAvailability(roomId)

		res.status(201).json(await booking.populate('room'))
	} catch (error) {
		res.status(500).json({ error: error.message })
	}
}

// Update booking with overlap checks and availability adjustments
const updateBooking = async (req, res) => {
    const { id } = req.params
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: 'Booking not found' })

    const allowed = ['startTime', 'endTime', 'userName', 'roomId']
    const updates = {}
    allowed.forEach((f) => {
        if (req.body[f] !== undefined) updates[f === 'roomId' ? 'room' : f] = req.body[f]
    })

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields provided for update' })

    try {
        const existing = await Booking.findById(id)
        if (!existing) return res.status(404).json({ error: 'Booking not found' })

        const oldRoomId = existing.room.toString() // Capture old room ID before update
        
        const newRoomId = updates.room ? updates.room : existing.room.toString()
        const newStart = updates.startTime ? new Date(updates.startTime) : existing.startTime
        const newEnd = updates.endTime ? new Date(updates.endTime) : existing.endTime

        if (isNaN(newStart) || isNaN(newEnd) || newStart >= newEnd) return res.status(400).json({ error: 'Invalid times' })
        if (!isAlignedTo30Min(newStart) || !isAlignedTo30Min(newEnd)) return res.status(400).json({ error: 'startTime and endTime must align to 30-minute intervals' })

        if (!mongoose.Types.ObjectId.isValid(newRoomId)) return res.status(404).json({ error: 'Room not found' })
        const room = await Room.findById(newRoomId)
        if (!room) return res.status(404).json({ error: 'Room not found' })

        const overlap = await hasOverlap(newRoomId, newStart, newEnd, id)
        if (overlap) return res.status(409).json({ error: 'Room already booked for given times' })

        // apply updates
        if (updates.userName) existing.userName = updates.userName
        existing.room = newRoomId
        existing.startTime = newStart
        existing.endTime = newEnd
        await existing.save()

        
        if (oldRoomId !== newRoomId) {
            await syncRoomAvailability(oldRoomId);
        }
        
        await syncRoomAvailability(newRoomId);

        res.status(200).json(await existing.populate('room'))
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
}

// Delete booking and update room availability
const deleteBooking = async (req, res) => {
	const { id } = req.params
	if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: 'Booking not found' })

	try {
		const booking = await Booking.findByIdAndDelete(id)
		if (!booking) return res.status(404).json({ error: 'Booking not found' })

		await syncRoomAvailability(booking.room)

		res.status(200).json({ message: 'Booking cancelled', booking })
	} catch (error) {
		res.status(500).json({ error: error.message })
	}
}

module.exports = {
	getBookings,
	getBooking,
	createBooking,
	updateBooking,
	deleteBooking,
	getBookingsByRoom
}
