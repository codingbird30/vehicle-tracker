const axios = require('axios');

const RTO_API_URL = process.env.RTO_API_URL;
const RTO_API_KEY = process.env.RTO_API_KEY;
const MAX_VEHICLE_AGE_YEARS = parseInt(process.env.MAX_VEHICLE_AGE_YEARS || '15', 10);

/**
 * Calls the RTO API for the given plate number.
 * Returns a normalized object regardless of provider shape.
 *
 * NOTE: This is a placeholder implementation. The expected response shape
 * mirrors common Indian RTO/VAHAN wrapper APIs (Surepass, Signzy, etc.).
 * When you switch to a real provider, just remap fields inside `normalize()`.
 */
async function fetchRTODetails(plateNumber) {
  // ---- MOCK MODE ----
  // If no real API key set, return a deterministic mock based on plate text.
  // This lets you test the full pipeline without paying for an API.
  if (!RTO_API_KEY || RTO_API_KEY === 'YOUR_RTO_API_KEY_HERE') {
    return mockRTOResponse(plateNumber);
  }

  try {
    const response = await axios.post(
      RTO_API_URL,
      { vehicle_number: plateNumber },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${RTO_API_KEY}`,
        },
        timeout: 8000,
      }
    );
    return { success: true, data: normalize(response.data), raw: response.data };
  } catch (err) {
    console.error('[RTO] API error:', err.message);
    return { success: false, data: null, raw: null, error: err.message };
  }
}

/** Map provider-specific fields into our internal shape. */
function normalize(apiResponse) {
  // Adjust these paths when wiring a real provider.
  const d = apiResponse.data || apiResponse.result || apiResponse;
  return {
    ownerName: d.owner_name || d.ownerName || null,
    address: d.permanent_address || d.address || null,
    model: d.model || d.maker_model || null,
    manufacturer: d.maker || d.manufacturer || null,
    fuelType: d.fuel_type || null,
    registrationDate: d.registration_date || d.reg_date || null,
    rtoLocation: d.rto || d.registered_at || null,
  };
}

/**
 * Decides whether a vehicle is authorized based on RTO data.
 * Rules:
 *   - API returned no data       -> unauthorized (reason: 'not_found' or 'api_error')
 *   - Registration > 15 yrs old  -> unauthorized (reason: 'expired')
 *   - Otherwise                  -> authorized
 */
function decideAuthorization(rtoResult) {
  if (!rtoResult.success || !rtoResult.data) {
    return {
      isAuthorized: false,
      reason: rtoResult.success ? 'not_found' : 'api_error',
    };
  }

  const regDateStr = rtoResult.data.registrationDate;
  if (!regDateStr) {
    return { isAuthorized: false, reason: 'no_registration_date' };
  }

  const regDate = new Date(regDateStr);
  if (isNaN(regDate.getTime())) {
    return { isAuthorized: false, reason: 'invalid_registration_date' };
  }

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - MAX_VEHICLE_AGE_YEARS);

  if (regDate < cutoff) {
    return { isAuthorized: false, reason: 'expired' };
  }

  return { isAuthorized: true, reason: null };
}

/** Mock data so the system runs end-to-end without a real RTO API. */
function mockRTOResponse(plateNumber) {
  // Plates ending in odd digit  -> recent registration (authorized)
  // Plates ending in even digit -> 18 years old        (unauthorized: expired)
  // Plate "NOTFOUND"            -> simulate not found
  if (plateNumber.toUpperCase().includes('NOTFOUND')) {
    return { success: true, data: null, raw: { status: 'not_found' } };
  }

  const lastChar = plateNumber.slice(-1);
  const lastDigit = parseInt(lastChar, 10);
  const isOld = !isNaN(lastDigit) && lastDigit % 2 === 0;

  const today = new Date();
  const regDate = isOld
    ? new Date(today.getFullYear() - 18, today.getMonth(), today.getDate())
    : new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());

  const mock = {
    owner_name: 'Demo User',
    permanent_address: 'Pune, Maharashtra, India',
    maker_model: isOld ? 'Maruti 800' : 'Hyundai Creta',
    maker: isOld ? 'Maruti Suzuki' : 'Hyundai',
    fuel_type: 'Petrol',
    registration_date: regDate.toISOString().split('T')[0],
    rto: 'MH-12 Pune',
  };

  return { success: true, data: normalize({ data: mock }), raw: mock };
}

module.exports = { fetchRTODetails, decideAuthorization };
