const axios = require('axios');

const RTO_API_URL = process.env.RTO_API_URL || 'https://api.fireapi.io/secure-app/rc-vehicle-info/v1';
const RTO_API_KEY = process.env.RTO_API_KEY;
const MAX_VEHICLE_AGE_YEARS = parseInt(process.env.MAX_VEHICLE_AGE_YEARS || '15', 10);

/**
 * Calls FireAPI for the given plate number.
 *   GET https://api.fireapi.io/secure-app/rc-vehicle-info/v1?vehicle_no=<PLATE>
 *   Header: x-api-key: <KEY>
 *
 * Response shape (from your Postman test):
 *   { status: 'success', data: { rc_owner_name, rc_maker_desc, rc_maker_model,
 *     rc_regn_dt, rc_fuel_desc, rc_registered_at, ... }, message: 'Data found!' }
 */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRTODetails(plateNumber) {
  // Mock fallback if no key set
  if (!RTO_API_KEY || RTO_API_KEY === 'YOUR_FIREAPI_KEY_HERE') {
    console.warn('[RTO] No FireAPI key set - returning mock data');
    return mockRTOResponse(plateNumber);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(RTO_API_URL, {
        params: { vehicle_no: plateNumber },
        headers: { 'x-api-key': RTO_API_KEY },
        timeout: 10000,
      });

      if (response.data?.status !== 'success' || !response.data?.data) {
        // "Not found" is a definitive answer — don't retry
        return { success: true, data: null, raw: response.data, notFound: true };
      }

      if (attempt > 1) {
        console.log(`[RTO] succeeded for ${plateNumber} on attempt ${attempt}`);
      }
      return {
        success: true,
        data: normalize(response.data.data),
        raw: response.data,
      };
    } catch (err) {
      lastError = err;
      const status = err.response?.status;

      // Don't retry on client errors (4xx) — they won't get better
      if (status && status >= 400 && status < 500) {
        console.error(`[RTO] FireAPI ${status} for ${plateNumber} (no retry):`, err.message);
        return { success: false, data: null, raw: null, error: err.message, attempts: attempt };
      }

      console.warn(`[RTO] attempt ${attempt}/${MAX_RETRIES} failed for ${plateNumber}: ${err.message}`);

      // Wait before retrying (exponential backoff: 500ms, 1000ms)
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }

  console.error(`[RTO] FireAPI failed after ${MAX_RETRIES} attempts:`, lastError?.message);
  return { success: false, data: null, raw: null, error: lastError?.message, attempts: MAX_RETRIES };
}

/** Map FireAPI rc_* fields to our internal shape. */
function normalize(rc) {
  return {
    ownerName: rc.rc_owner_name || null,
    fatherName: rc.rc_father_name || null,
    permanentAddress: rc.rc_permanent_address || null,
    presentAddress: rc.rc_present_address || null,
    manufacturer: rc.rc_maker_desc || null,
    model: rc.rc_maker_model || null,
    fuelType: rc.rc_fuel_desc || null,
    vehicleCategory: rc.rc_vch_catg || null,
    cubicCapacity: rc.rc_cubic_cap || null,
    seatingCapacity: rc.rc_seat_cap || null,
    chassisNumber: rc.rc_chasi_no || null,
    engineNumber: rc.rc_eng_no || null,
    manufactureYear: rc.rc_manu_month_yr ? String(rc.rc_manu_month_yr) : null,
    registrationDate: parseFireApiDate(rc.rc_regn_dt),
    fitnessUpto: rc.rc_fit_upto || null,
    rtoLocation: rc.rc_registered_at || null,
    rtoCode: rc.rc_rto_code || null,
    stateCode: rc.rc_state_code || null,
    insuranceCompany: rc.rc_insurance_comp || null,
    insurancePolicyNumber: rc.rc_insurance_policy_no || null,
    insuranceUpto: parseFireApiDate(rc.rc_insurance_upto),
  };
}

/** FireAPI dates come like "01/03/2025 00:00:00" (DD/MM/YYYY). */
function parseFireApiDate(str) {
  if (!str) return null;
  // Already ISO?
  const iso = new Date(str);
  if (!isNaN(iso.getTime()) && /\d{4}-\d{2}-\d{2}/.test(str)) return str;

  // DD/MM/YYYY [HH:MM:SS]
  const m = String(str).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm}-${dd}`;
  }
  return str;
}

function decideAuthorization(rtoResult) {
  if (!rtoResult.success) {
    return { isAuthorized: false, reason: 'api_error' };
  }
  if (rtoResult.notFound || !rtoResult.data) {
    return { isAuthorized: false, reason: 'not_found' };
  }

  const regDateStr = rtoResult.data.registrationDate;
  if (!regDateStr) return { isAuthorized: false, reason: 'no_registration_date' };

  const regDate = new Date(regDateStr);
  if (isNaN(regDate.getTime())) return { isAuthorized: false, reason: 'invalid_registration_date' };

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - MAX_VEHICLE_AGE_YEARS);

  if (regDate < cutoff) return { isAuthorized: false, reason: 'expired' };
  return { isAuthorized: true, reason: null };
}

function mockRTOResponse(plateNumber) {
  if (plateNumber.toUpperCase().includes('NOTFOUND')) {
    return { success: true, data: null, raw: { status: 'not_found' }, notFound: true };
  }
  const lastChar = plateNumber.slice(-1);
  const lastDigit = parseInt(lastChar, 10);
  const isOld = !isNaN(lastDigit) && lastDigit % 2 === 0;

  const today = new Date();
  const regDate = isOld
    ? new Date(today.getFullYear() - 18, today.getMonth(), today.getDate())
    : new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());

  const mock = {
    rc_owner_name: 'Demo User',
    rc_permanent_address: 'Pune, Maharashtra, India',
    rc_maker_model: isOld ? 'Maruti 800' : 'Hyundai Creta',
    rc_maker_desc: isOld ? 'MARUTI SUZUKI' : 'HYUNDAI',
    rc_fuel_desc: 'PETROL',
    rc_regn_dt: regDate.toISOString().split('T')[0],
    rc_registered_at: 'MH12, RTO',
    rc_rto_code: 'MH12',
    rc_state_code: 'MH',
  };
  return { success: true, data: normalize(mock), raw: mock };
}

module.exports = { fetchRTODetails, decideAuthorization };
