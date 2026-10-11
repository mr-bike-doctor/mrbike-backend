const assert=require('assert');
const mongoose=require('mongoose');
const {coordinatesValid,moneyValid,distanceKm}=require('../services/rsaValidation');

async function run(){
 assert(coordinatesValid('17.4','78.4'));assert(!coordinatesValid(91,0));assert(moneyValid(0));assert(!moneyValid(-1));
 assert(distanceKm(0,0,0,1)>110&&distanceKm(0,0,0,1)<112);
 console.log('RSA dispatch validation and fail-closed checks passed');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
