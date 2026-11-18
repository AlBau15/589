// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PagoAtomicoMXNB} from "../contracts/PagoAtomicoMXNB.sol";

/// @notice Despliega PagoAtomicoMXNB leyendo los parámetros de variables de entorno.
/// @dev Uso (ver docs/contrato.md):
///   forge script script/DesplegarPagoAtomicoMXNB.s.sol --rpc-url $ARBITRUM_RPC_URL --account <cuenta> --broadcast --verify
contract DesplegarPagoAtomicoMXNB is Script {
    function run() external returns (PagoAtomicoMXNB pago) {
        address mxnb = vm.envAddress("MXNB_ADDRESS");
        address tesoreria = vm.envAddress("TESORERIA_ADDRESS");
        address operador = vm.envAddress("OPERADOR_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        uint256 comision = vm.envUint("COMISION_BPS");
        require(comision <= type(uint16).max, "COMISION_BPS fuera de rango");
        uint16 comisionBps = uint16(comision);

        require(mxnb.code.length > 0, "MXNB_ADDRESS no es un contrato en esta red");

        vm.startBroadcast();
        pago = new PagoAtomicoMXNB(IERC20(mxnb), tesoreria, operador, comisionBps, owner);
        vm.stopBroadcast();

        console.log("PagoAtomicoMXNB desplegado en:", address(pago));
        console.log("Owner:", owner);
        console.log("Operador:", operador);
        console.log("Tesoreria:", tesoreria);
        console.log("Comision (bps):", uint256(comisionBps));
    }
}
