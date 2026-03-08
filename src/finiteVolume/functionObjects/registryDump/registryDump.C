/*---------------------------------------------------------------------------*\
  =========                 |
  \\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\    /   O peration     |
    \\  /    A nd           | www.openfoam.com
     \\/     M anipulation  |
-------------------------------------------------------------------------------
License
    This file is part of OpenFOAM.

    OpenFOAM is free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    OpenFOAM is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
    FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
    for more details.

    You should have received a copy of the GNU General Public License
    along with OpenFOAM.  If not, see <http://www.gnu.org/licenses/>.

\*---------------------------------------------------------------------------*/

#include "registryDump.H"
#include "addToRunTimeSelectionTable.H"
#include "fvMesh.H"
#include "Time.H"

// * * * * * * * * * * * * * * Static Data Members * * * * * * * * * * * * * //

namespace Foam
{
namespace functionObjects
{
    defineTypeNameAndDebug(registryDump, 0);
    addToRunTimeSelectionTable(functionObject, registryDump, dictionary);
}
}


// * * * * * * * * * * * * * * * * Constructors  * * * * * * * * * * * * * * //

Foam::functionObjects::registryDump::registryDump
(
    const word& name,
    const Time& runTime,
    const dictionary& dict
)
:
    fvMeshFunctionObject(name, runTime, dict)
{
    read(dict);
}


// * * * * * * * * * * * * * * * Member Functions  * * * * * * * * * * * * * //

bool Foam::functionObjects::registryDump::read(const dictionary& dict)
{
    fvMeshFunctionObject::read(dict);
    return true;
}


bool Foam::functionObjects::registryDump::execute()
{
    return true;
}


bool Foam::functionObjects::registryDump::write()
{
    const objectRegistry& obr = obr_;

    // Group objects by class name
    HashTable<wordHashSet> byClass = obr.classes();

    // Count total objects
    label totalObjects = 0;
    forAllConstIters(byClass, iter)
    {
        totalObjects += iter.val().size();
    }

    // Structured output to stdout (captured and parsed by the WASM worker).
    // Format: BEGIN_REGISTRY_DUMP / className { objName writeOpt; } / END
    Info<< "BEGIN_REGISTRY_DUMP t=" << time_.timeName()
        << " n=" << totalObjects << nl;

    wordList classNames(byClass.sortedToc());

    for (const word& className : classNames)
    {
        const wordHashSet& names = byClass[className];
        wordList sortedNames(names.sortedToc());

        Info<< className << nl;
        Info<< "{" << nl;

        for (const word& objName : sortedNames)
        {
            const regIOobject* objPtr = obr.cfindIOobject(objName);
            word writeStatus = "NO_WRITE";
            if (objPtr && objPtr->writeOpt() == IOobjectOption::AUTO_WRITE)
            {
                writeStatus = "AUTO_WRITE";
            }
            Info<< "    " << objName << "    " << writeStatus << ";" << nl;
        }

        Info<< "}" << nl;
    }

    Info<< "END_REGISTRY_DUMP" << nl << endl;

    return true;
}


// ************************************************************************* //
