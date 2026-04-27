const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema(
  {
    plateNumber: { type: String, required: true, uppercase: true, trim: true, index: true },
    isAuthorized: { type: Boolean, required: true, default: false },

    // Owner / address
    ownerName: { type: String, default: null },
    fatherName: { type: String, default: null },
    permanentAddress: { type: String, default: null },
    presentAddress: { type: String, default: null },

    // Vehicle details (from FireAPI rc_* fields)
    manufacturer: { type: String, default: null },     // rc_maker_desc
    model: { type: String, default: null },            // rc_maker_model
    fuelType: { type: String, default: null },         // rc_fuel_desc
    vehicleCategory: { type: String, default: null },  // rc_vch_catg
    cubicCapacity: { type: String, default: null },    // rc_cubic_cap
    seatingCapacity: { type: String, default: null }, // rc_seat_cap
    chassisNumber: { type: String, default: null },    // rc_chasi_no
    engineNumber: { type: String, default: null },     // rc_eng_no
    manufactureYear: { type: String, default: null }, // rc_manu_month_yr

    // Registration
    registrationDate: { type: Date, default: null },
    fitnessUpto: { type: String, default: null },
    rtoLocation: { type: String, default: null },
    rtoCode: { type: String, default: null },
    stateCode: { type: String, default: null },

    // Insurance
    insuranceCompany: { type: String, default: null },
    insurancePolicyNumber: { type: String, default: null },
    insuranceUpto: { type: String, default: null },

    // Auth metadata
    reason: { type: String, default: null },
    rawApiResponse: { type: mongoose.Schema.Types.Mixed, default: null },

    // OCR / capture
    capturedImagePath: { type: String, default: null },
    ocrSource: { type: String, default: null }, // 'plate-recognizer' or 'tesseract'
    ocrConfidence: { type: Number, default: null },

    detectedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Vehicle', vehicleSchema);
