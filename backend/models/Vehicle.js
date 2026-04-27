const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema(
  {
    plateNumber: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    isAuthorized: {
      type: Boolean,
      required: true,
      default: false,
    },
    ownerName: { type: String, default: null },
    address: { type: String, default: null },
    model: { type: String, default: null },
    manufacturer: { type: String, default: null },
    fuelType: { type: String, default: null },
    registrationDate: { type: Date, default: null },
    rtoLocation: { type: String, default: null },
    reason: { type: String, default: null }, // why unauthorized (expired / not_found / api_error)
    rawApiResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    capturedImagePath: { type: String, default: null },
    detectedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Vehicle', vehicleSchema);
